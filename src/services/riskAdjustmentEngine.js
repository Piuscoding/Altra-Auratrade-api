import Trade from "../models/Trade.js"
import { estimateNewsImpactPips } from "./newsFilterEngine.js"

/**
 * Smart Dynamic SL & Profit Lock.
 * ALL sub-features default OFF — only runs when strategy.riskAdjustment.enabled === true
 * and news filter is disabled for the account.
 */

export async function processPosition(trade, strategy, { newsFilterEnabled = true } = {}) {
  const ra = strategy.riskAdjustment || {}
  if (!ra.enabled) {
    return { adjusted: false, reason: "Risk adjustment disabled (default OFF)" }
  }
  if (newsFilterEnabled) {
    return { adjusted: false, reason: "News filter is ON — risk adjustment only runs when news filter is disabled" }
  }
  if (trade.status !== "open") {
    return { adjusted: false, reason: "Trade not open" }
  }
  if (trade.slAdjustment?.applied) {
    return { adjusted: false, reason: "Single adjustment already applied" }
  }

  const result = { adjusted: false, profitLock: false, details: {} }

  if (ra.profitLock50?.enabled && !trade.profitLockActivated) {
    const lock = await checkProfitLock(trade, ra.profitLock50.activationLevel || 50)
    if (lock.activate) {
      trade.originalSL = trade.originalSL ?? trade.stopLoss
      trade.stopLoss = lock.newSL
      trade.profitLockActivated = true
      trade.slAdjustment = {
        applied: true,
        originalSL: trade.originalSL,
        newSL: lock.newSL,
        adjustmentReason: "profit_lock",
        newsImpactEstimated: null,
        singleAdjustment: true,
      }
      await trade.save()
      return {
        adjusted: true,
        profitLock: true,
        reason: "50%+ profit lock activated",
        newSL: lock.newSL,
      }
    }
  }

  if (ra.trendAlignment) {
    const trend = detectTrendStub(trade)
    if (!trend.isClear) {
      return { adjusted: false, reason: "No clear trend for SL adjustment" }
    }

    let newsImpact = null
    if (ra.newsImpactCheck) {
      newsImpact = estimateNewsImpactPips(trade.pair, "generic")
    }

    if (ra.drawdownGuard || ra.capitalGuard) {
      // Guards: skip if would increase risk beyond original distance * 1.5
      const originalDist = Math.abs((trade.entryPrice || 0) - (trade.stopLoss || 0))
      const proposed = trend.isLong
        ? (trade.entryPrice || 0) - originalDist * 0.7
        : (trade.entryPrice || 0) + originalDist * 0.7
      const newDist = Math.abs((trade.entryPrice || 0) - proposed)
      if (newDist > originalDist * 1.5) {
        return { adjusted: false, reason: "Drawdown/capital guard blocked wider SL" }
      }

      trade.originalSL = trade.originalSL ?? trade.stopLoss
      trade.stopLoss = Number(proposed.toFixed(5))
      trade.slAdjustment = {
        applied: true,
        originalSL: trade.originalSL,
        newSL: trade.stopLoss,
        adjustmentReason: "trend_lock",
        newsImpactEstimated: newsImpact,
        singleAdjustment: true,
      }
      await trade.save()
      return {
        adjusted: true,
        reason: trend.isLong ? "SL moved toward higher low (trend lock)" : "SL moved toward lower high (trend lock)",
        newSL: trade.stopLoss,
        newsImpactEstimated: newsImpact,
      }
    }
  }

  return { adjusted: false, reason: "No adjustment conditions met" }
}

async function checkProfitLock(trade, activationLevel = 50) {
  if (trade.entryPrice == null || trade.takeProfit == null || trade.stopLoss == null) {
    return { activate: false }
  }
  const risk = Math.abs(trade.entryPrice - (trade.originalSL ?? trade.stopLoss))
  const reward = Math.abs(trade.takeProfit - trade.entryPrice)
  if (risk <= 0) return { activate: false }
  // Without live mark price we cannot measure floating profit; paper mode uses metadata.markPrice
  const mark = trade.metadata?.markPrice
  if (mark == null) return { activate: false }
  const floating = trade.direction === "long" ? mark - trade.entryPrice : trade.entryPrice - mark
  const target = risk * (activationLevel / 100) * (reward / risk)
  if (floating >= risk * (activationLevel / 100)) {
    return { activate: true, newSL: trade.entryPrice }
  }
  return { activate: false }
}

/** Lightweight structure stub until live multi-TF feed (Phase 6/7) */
function detectTrendStub(trade) {
  if (trade.direction === "long") {
    return { isClear: true, isLong: true }
  }
  if (trade.direction === "short") {
    return { isClear: true, isLong: false }
  }
  return { isClear: false, isLong: false }
}

export async function processOpenTradesForUser(userId, strategy) {
  const open = await Trade.find({ userId, strategyId: strategy._id, status: "open" })
  const results = []
  for (const t of open) {
    results.push(await processPosition(t, strategy, { newsFilterEnabled: false }))
  }
  return results
}
