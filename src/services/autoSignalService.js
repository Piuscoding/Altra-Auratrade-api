import Strategy from "../models/Strategy.js"
import BrokerAccount from "../models/BrokerAccount.js"
import Trade from "../models/Trade.js"
import { getCandles } from "./marketDataService.js"
import { processIncomingSignal } from "./tradingEngine.js"
import { effectiveRR } from "./strategyMetricsService.js"
import { writeAudit } from "./auditService.js"
import { notifyUser } from "./notificationService.js"

/**
 * Rule-based setup detector (same family as backtest):
 * long: close > SMA, bullish reverse candle
 * short: close < SMA, bearish reverse
 * SL/TP from range * designated/empirical RR
 */

function sma(values, period) {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function detectSetup(candles, { direction, minRR }) {
  if (!candles || candles.length < 25) return null
  const period = 20
  const closes = candles.map((c) => c.close)
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const mean = sma(closes, period)
  if (mean == null) return null

  const window = candles.slice(-period)
  const range =
    window.reduce((s, x) => s + (x.high - x.low), 0) / period || last.close * 0.001

  const allowLong = direction === "long" || direction === "long_short"
  const allowShort = direction === "short" || direction === "long_short"
  const bullish = last.close > last.open && prev.close < prev.open && last.close > mean
  const bearish = last.close < last.open && prev.close > prev.open && last.close < mean

  if (allowLong && bullish) {
    const entry = last.close
    const stopLoss = entry - range * 1.2
    const risk = entry - stopLoss
    const takeProfit = entry + risk * minRR
    return {
      direction: "long",
      entryPrice: Number(entry.toFixed(5)),
      stopLoss: Number(stopLoss.toFixed(5)),
      takeProfit: Number(takeProfit.toFixed(5)),
      reason: "structure_long_sma_reversal",
    }
  }
  if (allowShort && bearish) {
    const entry = last.close
    const stopLoss = entry + range * 1.2
    const risk = stopLoss - entry
    const takeProfit = entry - risk * minRR
    return {
      direction: "short",
      entryPrice: Number(entry.toFixed(5)),
      stopLoss: Number(stopLoss.toFixed(5)),
      takeProfit: Number(takeProfit.toFixed(5)),
      reason: "structure_short_sma_reversal",
    }
  }
  return null
}

async function countSignalsToday(userId, strategyId) {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  return Trade.countDocuments({
    userId,
    strategyId,
    createdAt: { $gte: start },
    status: { $nin: ["rejected"] },
  })
}

/**
 * Evaluate one strategy once across its autoSignal.pairs
 */
export async function evaluateStrategyAutoSignal(strategyId, { force = false } = {}) {
  const strategy = await Strategy.findById(strategyId)
  if (!strategy) return { ok: false, error: "Strategy not found" }

  const mark = async (fields) => {
    strategy.autoSignal = {
      ...(strategy.autoSignal?.toObject?.() || strategy.autoSignal || {}),
      ...fields,
    }
    await strategy.save()
  }

  if (!strategy.autoSignal?.enabled) {
    await mark({
      healthStatus: "disabled",
      lastResult: "Auto-signal disabled",
      lastError: null,
    })
    return { ok: false, error: "Auto-signal disabled" }
  }

  if (["disabled", "archived", "draft"].includes(strategy.status)) {
    strategy.autoSignal.enabled = false
    await mark({
      healthStatus: "disabled",
      lastResult: `Strategy status ${strategy.status} — auto-signal turned off`,
      lastError: `Status ${strategy.status}`,
      lastRunAt: new Date(),
    })
    return { ok: false, error: `Status ${strategy.status} not tradable` }
  }

  if (!["approved", "demo", "live"].includes(strategy.status)) {
    await mark({
      healthStatus: "skipped",
      lastResult: `Status ${strategy.status} not tradable`,
      lastError: `Status ${strategy.status}`,
      lastRunAt: new Date(),
    })
    return { ok: false, error: `Status ${strategy.status} not tradable` }
  }

  const intervalMin = strategy.autoSignal.intervalMinutes || 15
  const intervalMs = intervalMin * 60 * 1000
  if (!force && strategy.autoSignal.lastRunAt) {
    const elapsed = Date.now() - new Date(strategy.autoSignal.lastRunAt).getTime()
    if (elapsed < intervalMs * 0.85) {
      const nextRunAt = new Date(new Date(strategy.autoSignal.lastRunAt).getTime() + intervalMs)
      await mark({
        healthStatus: "skipped",
        lastResult: "interval_not_elapsed",
        nextRunAt,
      })
      return {
        ok: true,
        skipped: true,
        reason: "interval_not_elapsed",
        elapsedMs: elapsed,
        nextRunAt,
      }
    }
  }

  // Per-account assignment only when requireAssignedAccount (default true)
  const requireAccount = strategy.autoSignal.requireAssignedAccount !== false
  const assigned = await BrokerAccount.findOne({
    assignedStrategy: strategy._id,
    status: { $in: ["connected", "live", "testing"] },
  })
  if (requireAccount && !assigned) {
    const nextRunAt = new Date(Date.now() + intervalMs)
    await mark({
      lastRunAt: new Date(),
      lastError: "No connected broker account assigned to this strategy",
      lastResult: "no_assigned_account",
      healthStatus: "no_account",
      nextRunAt,
    })
    return {
      ok: false,
      error: "No connected broker account assigned to this strategy",
      reason: "no_assigned_account",
    }
  }

  // Re-check account still connected mid-config
  if (assigned && ["disconnected", "error"].includes(assigned.status)) {
    await mark({
      lastRunAt: new Date(),
      lastError: `Assigned account ${assigned.name} is ${assigned.status}`,
      lastResult: "account_disconnected",
      healthStatus: "error",
      nextRunAt: new Date(Date.now() + intervalMs),
    })
    return { ok: false, error: "Assigned account disconnected" }
  }

  // Cooldown since last accepted signal
  const gapMin = Number(strategy.autoSignal.minSignalGapMinutes) || 30
  if (!force && strategy.autoSignal.lastSignalAt) {
    const since = Date.now() - new Date(strategy.autoSignal.lastSignalAt).getTime()
    if (since < gapMin * 60 * 1000) {
      const nextRunAt = new Date(
        new Date(strategy.autoSignal.lastSignalAt).getTime() + gapMin * 60 * 1000
      )
      await mark({
        lastRunAt: new Date(),
        lastResult: "signal_gap_cooldown",
        healthStatus: "skipped",
        nextRunAt,
      })
      return {
        ok: true,
        skipped: true,
        reason: "signal_gap_cooldown",
        gapMin,
        nextRunAt,
      }
    }
  }

  const pairs =
    (strategy.autoSignal.pairs?.length && strategy.autoSignal.pairs) ||
    strategy.allowedPairs ||
    ["EURUSD"]
  const timeframe = strategy.autoSignal.timeframe || "H1"
  const minRR = effectiveRR(strategy)
  const direction = strategy.rules?.direction || "long_short"
  const maxPerDay = strategy.autoSignal.maxSignalsPerDay || 5

  const already = await countSignalsToday(strategy.userId, strategy._id)
  if (already >= maxPerDay) {
    const nextRunAt = new Date(Date.now() + intervalMs)
    await mark({
      lastRunAt: new Date(),
      lastError: `Daily signal cap reached (${maxPerDay})`,
      lastResult: "daily_cap",
      healthStatus: "skipped",
      nextRunAt,
    })
    return { ok: true, skipped: true, reason: "daily_cap", already }
  }

  const results = []
  let acceptedAny = false
  let lastStage = null

  for (const pair of pairs) {
    try {
      // Fresh strategy status each pair
      const live = await Strategy.findById(strategy._id).select("status autoSignal.enabled")
      if (!live?.autoSignal?.enabled || ["disabled", "archived"].includes(live.status)) {
        results.push({ pair, skipped: "strategy_disabled_mid_run" })
        break
      }
      if (requireAccount) {
        const acc = await BrokerAccount.findOne({
          _id: assigned._id,
          status: { $in: ["connected", "live", "testing"] },
        })
        if (!acc) {
          results.push({ pair, skipped: "account_disconnected_mid_run" })
          break
        }
      }

      const series = await getCandles({
        pair: String(pair).toUpperCase(),
        timeframe,
        count: 80,
      })
      const setup = detectSetup(series.candles, { direction, minRR })
      if (!setup) {
        results.push({ pair, setup: false })
        continue
      }

      const open = await Trade.findOne({
        userId: strategy.userId,
        strategyId: strategy._id,
        pair: String(pair).toUpperCase(),
        status: { $in: ["open", "pending", "signal_only"] },
      })
      if (open) {
        results.push({ pair, setup: true, skipped: "already_open", tradeId: open._id })
        continue
      }

      // processIncomingSignal applies news → session → risk → prop → pre-signal gates
      const payload = {
        strategyId: strategy._id,
        pair: String(pair).toUpperCase(),
        direction: setup.direction,
        entryPrice: setup.entryPrice,
        stopLoss: setup.stopLoss,
        takeProfit: setup.takeProfit,
        timeframe,
        confidence: strategy.overallConfidence || 0,
        metadata: {
          auto: true,
          reason: setup.reason,
          rrUsed: minRR,
          rrMode: strategy.rrMode || "designated",
          candleSource: series.source,
          timeframe,
          brokerAccountId: assigned?._id || null,
        },
      }

      const out = await processIncomingSignal(strategy.userId, payload)
      lastStage = out.stage || (out.accepted ? "accepted" : "rejected")
      results.push({
        pair,
        setup: true,
        accepted: out.accepted,
        stage: out.stage,
        tradeId: out.trade?._id,
        signalId: out.signal?._id,
        rejectReason: out.trade?.rejectReason || out.signal?.rejectReason || null,
      })

      if (out.accepted) {
        acceptedAny = true
        strategy.autoSignal.lastSignalAt = new Date()
        await notifyUser(strategy.userId, {
          type: "signal",
          title: "Auto-signal generated",
          body: `${pair} ${setup.direction} · RR 1:${minRR} · ${out.stage || "ok"}`,
          severity: "info",
          meta: { strategyId: strategy._id, pair, auto: true },
        })
        break
      }
    } catch (err) {
      results.push({ pair, error: err.message })
    }
  }

  const errMsg = results.find((r) => r.error)?.error || null
  const nextRunAt = new Date(Date.now() + intervalMs)
  let healthStatus = "ok"
  if (errMsg) healthStatus = "error"
  else if (!acceptedAny) healthStatus = "skipped"

  const summaryParts = results.map((r) => {
    if (r.error) return `${r.pair}:error`
    if (r.skipped) return `${r.pair}:${r.skipped}`
    if (r.setup === false) return `${r.pair}:no_setup`
    if (r.accepted) return `${r.pair}:accepted`
    return `${r.pair}:${r.stage || "rejected"}`
  })

  await mark({
    lastRunAt: new Date(),
    lastError: errMsg,
    lastResult: summaryParts.join(" · ") || "no_pairs",
    lastStage: lastStage,
    lastSignalAt: acceptedAny ? strategy.autoSignal.lastSignalAt : strategy.autoSignal.lastSignalAt,
    nextRunAt,
    healthStatus,
  })

  await writeAudit({
    userId: strategy.userId,
    action: "auto_signal.evaluate",
    resource: "Strategy",
    resourceId: strategy._id,
    summary: `Auto-signal · ${healthStatus} · ${summaryParts.join(", ")}`,
    details: {
      results,
      assigned: Boolean(assigned),
      accountId: assigned?._id,
      minRR,
      requireAccount,
    },
  })

  return {
    ok: true,
    results,
    minRR,
    assigned: Boolean(assigned),
    accountId: assigned?._id,
    healthStatus,
    nextRunAt,
    accepted: acceptedAny,
  }
}

export async function evaluateAllEnabledAutoSignals() {
  const list = await Strategy.find({
    "autoSignal.enabled": true,
    status: { $in: ["approved", "demo", "live"] },
  }).select("_id autoSignal")

  const outcomes = []
  for (const s of list) {
    try {
      const r = await evaluateStrategyAutoSignal(s._id, { force: false })
      outcomes.push({ strategyId: s._id, ...r })
    } catch (err) {
      outcomes.push({ strategyId: s._id, ok: false, error: err.message })
    }
  }
  return { count: list.length, outcomes }
}

export async function getAutoSignalHealth(userId, strategyId) {
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) throw Object.assign(new Error("Strategy not found"), { status: 404 })
  const assigned = await BrokerAccount.findOne({
    assignedStrategy: strategy._id,
  }).select("name status type provider")
  const as = strategy.autoSignal || {}
  const intervalMin = as.intervalMinutes || 15
  let nextRunAt = as.nextRunAt || null
  if (!nextRunAt && as.lastRunAt) {
    nextRunAt = new Date(new Date(as.lastRunAt).getTime() + intervalMin * 60 * 1000)
  }
  return {
    enabled: Boolean(as.enabled),
    healthStatus: as.healthStatus || "idle",
    lastRunAt: as.lastRunAt || null,
    lastSignalAt: as.lastSignalAt || null,
    lastError: as.lastError || null,
    lastResult: as.lastResult || null,
    lastStage: as.lastStage || null,
    nextRunAt,
    intervalMinutes: intervalMin,
    minSignalGapMinutes: as.minSignalGapMinutes || 30,
    maxSignalsPerDay: as.maxSignalsPerDay || 5,
    requireAssignedAccount: as.requireAssignedAccount !== false,
    pairs: as.pairs || [],
    timeframe: as.timeframe || "H1",
    assignedAccount: assigned
      ? { id: assigned._id, name: assigned.name, status: assigned.status, type: assigned.type }
      : null,
  }
}

export async function setAutoSignal(userId, strategyId, config) {
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) throw Object.assign(new Error("Strategy not found"), { status: 404 })
  if (!["approved", "demo", "live"].includes(strategy.status) && config.enabled) {
    throw Object.assign(
      new Error("Only approved, demo, or live strategies can enable auto-signal"),
      { status: 400 }
    )
  }

  const prev = strategy.autoSignal || {}
  strategy.autoSignal = {
    enabled: Boolean(config.enabled),
    intervalMinutes: Math.min(240, Math.max(5, Number(config.intervalMinutes) || 15)),
    timeframe: config.timeframe || prev.timeframe || "H1",
    pairs:
      Array.isArray(config.pairs) && config.pairs.length
        ? config.pairs.map((p) => String(p).toUpperCase())
        : prev.pairs || ["EURUSD"],
    maxSignalsPerDay: Math.min(50, Math.max(1, Number(config.maxSignalsPerDay) || 5)),
    requireAssignedAccount:
      config.requireAssignedAccount != null
        ? Boolean(config.requireAssignedAccount)
        : prev.requireAssignedAccount !== false,
    minSignalGapMinutes: Math.min(
      240,
      Math.max(5, Number(config.minSignalGapMinutes ?? prev.minSignalGapMinutes) || 30)
    ),
    lastRunAt: prev.lastRunAt || null,
    lastSignalAt: prev.lastSignalAt || null,
    lastError: prev.lastError || null,
    lastResult: prev.lastResult || null,
    lastStage: prev.lastStage || null,
    nextRunAt: prev.nextRunAt || null,
    healthStatus: config.enabled ? prev.healthStatus || "idle" : "disabled",
  }
  await strategy.save()
  return strategy
}
