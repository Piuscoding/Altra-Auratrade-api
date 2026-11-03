import Strategy from "../models/Strategy.js"
import Trade from "../models/Trade.js"
import BrokerAccount from "../models/BrokerAccount.js"

/**
 * Realized R-multiple: pnl in units of initial risk (entry-SL distance * direction).
 * If prices missing, falls back to sign of pnl only.
 */
export function realizedRMultiple(trade) {
  const entry = Number(trade.entryPrice)
  const sl = Number(trade.stopLoss)
  const pnl = Number(trade.pnl) || 0
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry === sl) {
    if (pnl > 0) return 1
    if (pnl < 0) return -1
    return 0
  }
  const riskDist = Math.abs(entry - sl)
  if (riskDist <= 0) return 0
  // Approximate: map pnl to R using risk distance if lot sizing unknown —
  // Prefer explicit R if metadata has it
  if (trade.metadata?.realizedRR != null) return Number(trade.metadata.realizedRR)
  const tp = Number(trade.takeProfit)
  if (Number.isFinite(tp) && trade.status === "closed") {
    // If closed at/near TP
    const rewardDist = Math.abs(tp - entry)
    if (pnl > 0 && rewardDist > 0) {
      return rewardDist / riskDist
    }
    if (pnl < 0) return -1
    if (pnl === 0) return 0
  }
  // Scale unknown lot: use pnl sign with magnitude heuristic
  if (pnl > 0) {
    return tp && Math.abs(tp - entry) > 0 ? Math.abs(tp - entry) / riskDist : 1
  }
  if (pnl < 0) return -1
  return 0
}

function median(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function modeRounded(nums, step = 0.5) {
  if (!nums.length) return 0
  const buckets = {}
  for (const n of nums) {
    const b = Math.round(n / step) * step
    buckets[b] = (buckets[b] || 0) + 1
  }
  let best = 0
  let bestC = 0
  for (const [k, c] of Object.entries(buckets)) {
    if (c > bestC) {
      bestC = c
      best = Number(k)
    }
  }
  return best
}

export function buildBucketFromTradeList(trades, designatedRR = 2) {
  const closed = trades.filter((t) => t.status === "closed")
  const wins = closed.filter((t) => (t.pnl || 0) > 0)
  const losses = closed.filter((t) => (t.pnl || 0) <= 0)
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0
  const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0
  const avgWin = wins.length ? grossWin / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  const expectancy =
    closed.length && (avgLoss > 0 || avgWin > 0)
      ? (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss
      : 0

  const rMultiples = closed.map(realizedRMultiple)
  const positiveR = rMultiples.filter((r) => r > 0)
  const avgRealizedRR = positiveR.length
    ? positiveR.reduce((a, b) => a + b, 0) / positiveR.length
    : 0
  const medianRealizedRR = median(positiveR)
  const highProbabilityRR = modeRounded(positiveR, 0.5)
  const hitDesignated = positiveR.filter((r) => r + 1e-9 >= designatedRR).length
  const designatedRRHitRate = positiveR.length
    ? (hitDesignated / positiveR.length) * 100
    : 0

  // simple max DD approximation on cumulative pnl
  let equity = 0
  let peak = 0
  let maxDD = 0
  for (const t of closed) {
    equity += t.pnl || 0
    peak = Math.max(peak, equity)
    const dd = peak > 0 ? ((peak - equity) / Math.max(peak, 1)) * 100 : 0
    maxDD = Math.max(maxDD, dd)
  }

  return {
    winRate: Number(winRate.toFixed(2)),
    expectancy: Number(expectancy.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(2)),
    maxDD: Number(maxDD.toFixed(2)),
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    avgRealizedRR: Number(avgRealizedRR.toFixed(2)),
    medianRealizedRR: Number(medianRealizedRR.toFixed(2)),
    designatedRRHitRate: Number(designatedRRHitRate.toFixed(2)),
    highProbabilityRR: Number(highProbabilityRR.toFixed(2)),
    lastUpdatedAt: new Date(),
  }
}

export function buildBucketFromBacktestResults(results, designatedRR = 2) {
  const tradeList = results?.tradeList || []
  const mapped = tradeList.map((t) => {
    const risk = 1 // sim trades already sized in risk units conceptually via pnl ratio
    let realizedRR = 0
    if (t.pnl > 0 && t.entry != null && t.exit != null) {
      // approximate from direction
      realizedRR = designatedRR // many sims exit at TP = designated RR
      if (t.reason === "tp") realizedRR = designatedRR
      else if (t.reason === "eod") realizedRR = Math.max(0.1, designatedRR * 0.5)
      else realizedRR = Math.abs(t.pnl) > 0 ? designatedRR * 0.8 : 0
    } else if (t.pnl < 0) {
      realizedRR = -1
    }
    return {
      status: "closed",
      pnl: t.pnl,
      entryPrice: t.entry,
      stopLoss: t.direction === "long" ? t.entry - 1 : t.entry + 1,
      takeProfit:
        t.direction === "long"
          ? t.entry + designatedRR
          : t.entry - designatedRR,
      metadata: { realizedRR: t.pnl > 0 ? (t.reason === "tp" ? designatedRR : Math.abs(t.pnl)) : t.pnl < 0 ? -1 : 0 },
    }
  })

  // Prefer full counts from results
  const bucket = buildBucketFromTradeList(mapped, designatedRR)
  bucket.winRate = results.winRate ?? bucket.winRate
  bucket.expectancy = results.expectancy ?? bucket.expectancy
  bucket.profitFactor = results.profitFactor ?? bucket.profitFactor
  bucket.maxDD = results.maxDrawdownPercent ?? bucket.maxDD
  bucket.trades = results.trades ?? bucket.trades
  bucket.wins = results.wins ?? bucket.wins
  bucket.losses = results.losses ?? bucket.losses
  if (results.avgRealizedRR != null) bucket.avgRealizedRR = results.avgRealizedRR
  if (results.designatedRRHitRate != null) {
    bucket.designatedRRHitRate = results.designatedRRHitRate
  }
  if (results.highProbabilityRR != null) {
    bucket.highProbabilityRR = results.highProbabilityRR
  }
  return bucket
}

export async function recomputeDemoMetrics(strategyId) {
  const strategy = await Strategy.findById(strategyId)
  if (!strategy) return null
  const designatedRR = Number(strategy.designatedRR || strategy.rules?.minRR || 2)

  const trades = await Trade.find({
    strategyId,
    status: "closed",
  }).lean()

  // Demo = trades on demo broker accounts or accountType demo / paper
  const brokerIds = [
    ...new Set(trades.filter((t) => t.brokerAccountId).map((t) => String(t.brokerAccountId))),
  ]
  const brokers = await BrokerAccount.find({ _id: { $in: brokerIds } }).lean()
  const demoBrokerIds = new Set(
    brokers.filter((b) => b.type === "demo").map((b) => String(b._id))
  )

  const demoTrades = trades.filter(
    (t) =>
      t.accountType === "demo" ||
      t.executionMethod === "paper" ||
      (t.brokerAccountId && demoBrokerIds.has(String(t.brokerAccountId)))
  )

  const demoBucket = buildBucketFromTradeList(demoTrades, designatedRR)
  strategy.metrics = strategy.metrics || {}
  strategy.metrics.demo = demoBucket
  await strategy.save()
  return strategy
}

export async function applyBacktestMetrics(strategy, results) {
  const designatedRR = Number(strategy.designatedRR || strategy.rules?.minRR || 2)
  const bucket = buildBucketFromBacktestResults(results, designatedRR)
  strategy.metrics = strategy.metrics || {}
  strategy.metrics.backtest = bucket
  strategy.performance = {
    winRate: bucket.winRate,
    expectancy: bucket.expectancy,
    profitFactor: bucket.profitFactor,
    maxDD: bucket.maxDD,
    trades: bucket.trades,
  }
  // Keep rules.minRR aligned when designatedRR set
  if (strategy.designatedRR && strategy.rules) {
    strategy.rules = { ...strategy.rules, minRR: strategy.designatedRR }
  }
  await strategy.save()
  return strategy
}

export function effectiveRR(strategy) {
  const designated = Number(strategy.designatedRR || strategy.rules?.minRR || 2)
  if (strategy.rrMode === "empirical") {
    const emp =
      strategy.metrics?.demo?.highProbabilityRR ||
      strategy.metrics?.backtest?.highProbabilityRR ||
      designated
    return Number(emp) > 0 ? Number(emp) : designated
  }
  return designated
}
