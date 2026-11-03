import { getUpcomingEvents, estimateNewsImpactPips } from "./newsFilterEngine.js"
import Trade from "../models/Trade.js"
import Signal from "../models/Signal.js"
import Strategy from "../models/Strategy.js"
import { getCandles } from "./marketDataService.js"
import { generateCandles as generateCandlesSynthetic } from "./chartServiceSynthetic.js"

export { generateCandlesSynthetic as generateCandles }

export function buildNewsImpactMarkers(pair, candles) {
  const events = getUpcomingEvents(240)
  const lastTime = candles?.length ? candles[candles.length - 1].time : Math.floor(Date.now() / 1000)
  const markers = []

  for (const ev of events) {
    const t = Math.floor(new Date(ev.time).getTime() / 1000)
    const pips = estimateNewsImpactPips(pair, ev.name)
    markers.push({
      id: `${ev.name}-${t}`,
      time: t,
      label: ev.name,
      impact: ev.impact || "high",
      estimatedPips: pips,
      kind: "news",
      withinChart: t >= (candles?.[0]?.time || 0) - 3600 && t <= lastTime + 3600,
    })
  }
  return markers
}

export async function buildTradeOverlays(userId, { pair, strategyId } = {}) {
  const q = {
    userId,
    status: { $in: ["open", "pending", "signal_only"] },
  }
  if (pair) q.pair = String(pair).toUpperCase()
  if (strategyId) q.strategyId = strategyId

  const trades = await Trade.find(q).sort({ createdAt: -1 }).limit(20)
  return trades.map((t) => {
    const entry = t.entryPrice
    const sl = t.stopLoss
    const tp = t.takeProfit
    let risk = null
    let reward = null
    let rr = null
    if (entry != null && sl != null) risk = Math.abs(entry - sl)
    if (entry != null && tp != null) reward = Math.abs(tp - entry)
    if (risk && reward) rr = Number((reward / risk).toFixed(2))

    let slStatus = "active"
    if (t.profitLockActivated) slStatus = "profit_lock"
    else if (t.slAdjustment?.applied) slStatus = t.slAdjustment.adjustmentReason || "adjusted"
    else if (t.status === "pending") slStatus = "pending"
    else if (t.status === "signal_only") slStatus = "signal_only"

    return {
      tradeId: t._id,
      pair: t.pair,
      direction: t.direction,
      status: t.status,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      originalSL: t.originalSL,
      rr,
      profitLockActivated: t.profitLockActivated,
      slAdjustment: t.slAdjustment,
      slStatus,
      session: t.session,
      newsImpact: t.slAdjustment?.newsImpactEstimated ?? null,
    }
  })
}

export async function buildStrategyLevels(userId, strategyId) {
  if (!strategyId) return null
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) return null
  return {
    strategyId: strategy._id,
    name: strategy.name,
    rules: strategy.rules || {},
    plottedLevels: strategy.plottedLevels || {},
    overallConfidence: strategy.overallConfidence,
  }
}

export async function buildFocusMarkup(userId, { tradeId, signalId } = {}) {
  if (tradeId) {
    const trade = await Trade.findOne({ _id: tradeId, userId })
    if (trade) {
      const strategy = trade.strategyId
        ? await Strategy.findOne({ _id: trade.strategyId, userId })
        : null
      const entry = trade.entryPrice
      const sl = trade.stopLoss
      const tp = trade.takeProfit
      let rr = null
      if (entry != null && sl != null && tp != null && entry !== sl) {
        rr = Number((Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2))
      }
      return {
        kind: "trade",
        tradeId: trade._id,
        signalId: trade.signalId || null,
        pair: trade.pair,
        direction: trade.direction,
        entry,
        stopLoss: sl,
        takeProfit: tp,
        rr,
        status: trade.status,
        outcome: trade.outcome,
        strategyId: trade.strategyId,
        strategyName: strategy?.name || null,
        plottedLevels: strategy?.plottedLevels || {},
        rules: strategy?.rules || {},
      }
    }
  }
  if (signalId) {
    const signal = await Signal.findOne({ _id: signalId, userId })
    if (signal) {
      const strategy = signal.strategyId
        ? await Strategy.findOne({ _id: signal.strategyId, userId })
        : null
      const markup = signal.chartMarkup || {}
      const entry = markup.entry ?? signal.entryPrice
      const sl = markup.stopLoss ?? signal.stopLoss
      const tp = markup.takeProfit ?? signal.takeProfit
      let rr = markup.rr
      if (rr == null && entry != null && sl != null && tp != null && entry !== sl) {
        rr = Number((Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2))
      }
      return {
        kind: "signal",
        signalId: signal._id,
        tradeId: signal.tradeId || null,
        pair: signal.pair,
        direction: signal.direction,
        entry,
        stopLoss: sl,
        takeProfit: tp,
        rr,
        status: signal.status,
        strategyId: signal.strategyId,
        strategyName: markup.strategyName || strategy?.name || null,
        plottedLevels: markup.plottedLevels || strategy?.plottedLevels || {},
        rules: markup.rules || strategy?.rules || {},
        source: markup.source || "signal",
      }
    }
  }
  return null
}

export async function getWorkspaceBundle(userId, query) {
  let pair = (query.pair || "EURUSD").toUpperCase()
  const timeframe = query.timeframe || "M15"
  const count = Math.min(Number(query.count) || 200, 500)
  let strategyId = query.strategyId || null
  const tradeId = query.tradeId || null
  const signalId = query.signalId || null

  const focusMarkup = await buildFocusMarkup(userId, { tradeId, signalId })
  if (focusMarkup?.pair) pair = String(focusMarkup.pair).toUpperCase()
  if (focusMarkup?.strategyId && !strategyId) strategyId = String(focusMarkup.strategyId)

  const series = await getCandles({ pair, timeframe, count })
  const newsMarkers = buildNewsImpactMarkers(pair, series.candles)
  const overlays = await buildTradeOverlays(userId, { pair, strategyId })
  const strategyLevels = await buildStrategyLevels(userId, strategyId)

  return {
    ...series,
    pair,
    timeframe,
    newsMarkers,
    overlays,
    strategyLevels,
    focusMarkup,
    generatedAt: new Date().toISOString(),
  }
}
