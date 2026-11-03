import Strategy from "../models/Strategy.js"
import PerformanceSnapshot from "../models/PerformanceSnapshot.js"
import AdminSettings from "../models/AdminSettings.js"

/**
 * Learning / promotion layer on top of backtests.
 * - Evaluates optional admin promotion gates (not forced demo days)
 * - Stores performance snapshots over time
 * - Computes walk-forward stability helpers
 */

export const DEFAULT_PROMOTION_GATES = {
  enabled: false,
  minTrades: 20,
  minWinRate: 45,
  minExpectancy: 0,
  maxDrawdownPercent: 20,
  minProfitFactor: 1.1,
  minDesignatedRRHitRate: 40,
  minWalkForwardFoldPassRate: 50,
  minStabilityScore: 40,
}

export async function getPromotionGates() {
  try {
    const s = await AdminSettings.findOne()
    return {
      ...DEFAULT_PROMOTION_GATES,
      ...(s?.promotionGates || {}),
    }
  } catch {
    return { ...DEFAULT_PROMOTION_GATES }
  }
}

/**
 * stabilityScore 0-100 from fold consistency (win rates / expectancy signs)
 */
export function computeStabilityScore(folds = []) {
  if (!folds.length) return 0
  const wrs = folds.map((f) => Number(f.winRate) || 0)
  const mean = wrs.reduce((a, b) => a + b, 0) / wrs.length
  const variance =
    wrs.reduce((s, w) => s + (w - mean) * (w - mean), 0) / wrs.length
  const std = Math.sqrt(variance)
  // lower std relative to mean => higher score
  const cv = mean > 0 ? std / mean : 1
  const positiveFolds = folds.filter((f) => (f.netProfit || 0) > 0).length
  const passRate = (positiveFolds / folds.length) * 100
  const consistency = Math.max(0, 100 - cv * 100)
  return Number((0.55 * consistency + 0.45 * passRate).toFixed(2))
}

export function evaluatePromotion(metrics, gates, { folds = [] } = {}) {
  const g = { ...DEFAULT_PROMOTION_GATES, ...gates }
  const failures = []
  const checks = {}

  if (!g.enabled) {
    return {
      passed: true,
      gates: g,
      failures: [],
      note: "Promotion gates disabled — informational only",
      checks: {},
    }
  }

  const minTrades = Number(g.minTrades) || 0
  checks.trades = { value: metrics.trades || 0, min: minTrades }
  if ((metrics.trades || 0) < minTrades) failures.push(`trades < ${minTrades}`)

  const minWR = Number(g.minWinRate) || 0
  checks.winRate = { value: metrics.winRate || 0, min: minWR }
  if ((metrics.winRate || 0) < minWR) failures.push(`winRate < ${minWR}%`)

  const minExp = Number(g.minExpectancy)
  checks.expectancy = { value: metrics.expectancy || 0, min: minExp }
  if ((metrics.expectancy || 0) < minExp) failures.push(`expectancy < ${minExp}`)

  const maxDD = Number(g.maxDrawdownPercent) || 100
  checks.maxDD = { value: metrics.maxDD || metrics.maxDrawdownPercent || 0, max: maxDD }
  if ((metrics.maxDD || metrics.maxDrawdownPercent || 0) > maxDD) {
    failures.push(`maxDD > ${maxDD}%`)
  }

  const minPF = Number(g.minProfitFactor) || 0
  checks.profitFactor = { value: metrics.profitFactor || 0, min: minPF }
  if ((metrics.profitFactor || 0) < minPF) failures.push(`profitFactor < ${minPF}`)

  const minHit = Number(g.minDesignatedRRHitRate) || 0
  checks.designatedRRHitRate = {
    value: metrics.designatedRRHitRate || 0,
    min: minHit,
  }
  if ((metrics.designatedRRHitRate || 0) < minHit) {
    failures.push(`designatedRRHitRate < ${minHit}%`)
  }

  if (folds.length) {
    const positive = folds.filter((f) => (f.netProfit || 0) > 0).length
    const foldPassRate = (positive / folds.length) * 100
    const minFold = Number(g.minWalkForwardFoldPassRate) || 0
    checks.foldPassRate = { value: Number(foldPassRate.toFixed(2)), min: minFold }
    if (foldPassRate < minFold) failures.push(`walk-forward fold pass rate < ${minFold}%`)

    const stability = metrics.stabilityScore ?? computeStabilityScore(folds)
    const minStab = Number(g.minStabilityScore) || 0
    checks.stabilityScore = { value: stability, min: minStab }
    if (stability < minStab) failures.push(`stabilityScore < ${minStab}`)
  }

  return {
    passed: failures.length === 0,
    gates: g,
    failures,
    checks,
    note: failures.length ? "Not ready for live promotion under current gates" : "Passes promotion gates",
  }
}

export async function createSnapshot({
  userId,
  strategyId,
  source,
  backtestRunId = null,
  pair,
  timeframe,
  metrics,
  folds = [],
  notes = "",
}) {
  const gates = await getPromotionGates()
  const stabilityScore =
    metrics.stabilityScore ?? computeStabilityScore(folds)
  const foldPassRate = folds.length
    ? Number(
        (
          (folds.filter((f) => (f.netProfit || 0) > 0).length / folds.length) *
          100
        ).toFixed(2)
      )
    : undefined

  const enriched = {
    ...metrics,
    stabilityScore,
    foldPassRate,
  }
  const promotion = evaluatePromotion(enriched, gates, { folds })

  const snap = await PerformanceSnapshot.create({
    userId,
    strategyId,
    source,
    backtestRunId,
    pair,
    timeframe,
    metrics: enriched,
    promotion: {
      passed: promotion.passed,
      gates: promotion.gates,
      failures: promotion.failures,
    },
    notes,
  })
  return { snapshot: snap, promotion }
}

export async function listSnapshots(userId, { strategyId, limit = 30 } = {}) {
  const q = { userId }
  if (strategyId) q.strategyId = strategyId
  return PerformanceSnapshot.find(q).sort({ createdAt: -1 }).limit(limit)
}

export async function evaluateStrategyPromotion(strategyId, userId) {
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) throw Object.assign(new Error("Strategy not found"), { status: 404 })
  const gates = await getPromotionGates()
  const bt = strategy.metrics?.backtest || strategy.performance || {}
  const demo = strategy.metrics?.demo || {}
  // Prefer richer data source
  const metrics = {
    winRate: bt.winRate || demo.winRate || 0,
    expectancy: bt.expectancy || demo.expectancy || 0,
    profitFactor: bt.profitFactor || demo.profitFactor || 0,
    maxDD: bt.maxDD || demo.maxDD || 0,
    trades: bt.trades || demo.trades || 0,
    designatedRRHitRate: bt.designatedRRHitRate || demo.designatedRRHitRate || 0,
    avgRealizedRR: bt.avgRealizedRR || demo.avgRealizedRR || 0,
    highProbabilityRR: bt.highProbabilityRR || demo.highProbabilityRR || 0,
    stabilityScore: bt.stabilityScore || 0,
  }
  const promotion = evaluatePromotion(metrics, gates, { folds: [] })
  return { strategy, metrics, promotion, gates }
}
