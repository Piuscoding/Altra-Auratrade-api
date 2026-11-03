import Strategy from "../models/Strategy.js"
import AdminSettings from "../models/AdminSettings.js"
import User from "../models/User.js"
import { runBacktest } from "./backtestService.js"
import { evaluatePromotion, getPromotionGates } from "./learningService.js"
import { writeAudit } from "./auditService.js"

/**
 * Pre-signal validation: optional quick backtest + metric gates
 * before a manual or auto signal is accepted.
 */

export const DEFAULT_PRE_SIGNAL = {
  enabled: false,
  mode: "warn", // "warn" | "block"
  runQuickBacktest: true,
  candleCount: 180,
  timeframe: "H1",
  usePromotionGates: true,
  minTrades: 10,
  minWinRate: 40,
  minExpectancy: 0,
  maxDrawdownPercent: 25,
}

export async function resolvePreSignalPolicy(userId) {
  const [settings, user] = await Promise.all([
    AdminSettings.findOne(),
    User.findById(userId).select("preferences"),
  ])

  const globalOn = settings?.globalFeatureToggles?.preSignalValidation === true
  const globalMode = settings?.preSignalValidation?.mode || "block"
  const globalCfg = {
    ...DEFAULT_PRE_SIGNAL,
    ...(settings?.preSignalValidation || {}),
    enabled: globalOn,
    mode: globalMode,
  }

  const userPref = user?.preferences?.preSignalValidation || {}
  // User can enable on top of global, or force stricter local settings when global is on
  const enabled = globalOn || userPref.enabled === true
  const mode =
    globalOn && globalMode === "block"
      ? "block"
      : userPref.mode || globalCfg.mode || "warn"

  return {
    enabled,
    mode,
    runQuickBacktest:
      userPref.runQuickBacktest != null
        ? userPref.runQuickBacktest
        : globalCfg.runQuickBacktest !== false,
    candleCount: Number(userPref.candleCount || globalCfg.candleCount || 180),
    timeframe: userPref.timeframe || globalCfg.timeframe || "H1",
    usePromotionGates: globalCfg.usePromotionGates !== false,
    minTrades: Number(userPref.minTrades || globalCfg.minTrades || 10),
    minWinRate: Number(userPref.minWinRate || globalCfg.minWinRate || 40),
    minExpectancy: Number(
      userPref.minExpectancy != null ? userPref.minExpectancy : globalCfg.minExpectancy ?? 0
    ),
    maxDrawdownPercent: Number(
      userPref.maxDrawdownPercent || globalCfg.maxDrawdownPercent || 25
    ),
    globalForced: globalOn,
  }
}

function metricsFromBacktest(results = {}) {
  return {
    winRate: results.winRate || 0,
    expectancy: results.expectancy || 0,
    profitFactor: results.profitFactor || 0,
    maxDD: results.maxDrawdownPercent || results.maxDD || 0,
    trades: results.trades || 0,
    designatedRRHitRate: results.designatedRRHitRate || 0,
    stabilityScore: results.stabilityScore || 0,
    foldPassRate: results.foldPassRate || 0,
  }
}

function metricsFromStrategy(strategy) {
  const bt = strategy.metrics?.backtest || strategy.performance || {}
  return {
    winRate: bt.winRate || 0,
    expectancy: bt.expectancy || 0,
    profitFactor: bt.profitFactor || 0,
    maxDD: bt.maxDD || bt.maxDrawdownPercent || 0,
    trades: bt.trades || 0,
    designatedRRHitRate: bt.designatedRRHitRate || 0,
    stabilityScore: bt.stabilityScore || 0,
    foldPassRate: bt.foldPassRate || 0,
  }
}

/**
 * @returns {{ ok: boolean, blocked: boolean, mode: string, note: string, failures: string[], metrics: object, backtestRunId?: string }}
 */
export async function validateBeforeSignal(userId, { strategyId, pair }) {
  const policy = await resolvePreSignalPolicy(userId)
  if (!policy.enabled) {
    return {
      ok: true,
      blocked: false,
      mode: policy.mode,
      note: "Pre-signal validation disabled",
      failures: [],
      metrics: null,
      policy,
    }
  }

  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    return {
      ok: false,
      blocked: policy.mode === "block",
      mode: policy.mode,
      note: "Strategy not found for pre-signal validation",
      failures: ["strategy_missing"],
      metrics: null,
      policy,
    }
  }

  let metrics = metricsFromStrategy(strategy)
  let backtestRunId = null
  let backtestError = null

  if (policy.runQuickBacktest) {
    try {
      const run = await runBacktest(userId, {
        strategyId: strategy._id,
        pair: pair || strategy.pairs?.[0] || "EURUSD",
        timeframe: policy.timeframe,
        mode: "historical",
        candleCount: policy.candleCount,
        riskPerTradePercent: 1,
        initialBalance: 10000,
        minRR: strategy.designatedRR || strategy.rules?.minRR || 2,
      })
      backtestRunId = run?._id
      if (run?.results) metrics = metricsFromBacktest(run.results)
    } catch (err) {
      backtestError = err.message
      // fall back to stored metrics
    }
  }

  const failures = []
  if ((metrics.trades || 0) < policy.minTrades) {
    failures.push(`trades ${metrics.trades} < min ${policy.minTrades}`)
  }
  if ((metrics.winRate || 0) < policy.minWinRate) {
    failures.push(`winRate ${metrics.winRate}% < min ${policy.minWinRate}%`)
  }
  if ((metrics.expectancy || 0) < policy.minExpectancy) {
    failures.push(`expectancy ${metrics.expectancy} < min ${policy.minExpectancy}`)
  }
  if ((metrics.maxDD || 0) > policy.maxDrawdownPercent) {
    failures.push(`maxDD ${metrics.maxDD}% > max ${policy.maxDrawdownPercent}%`)
  }

  if (policy.usePromotionGates) {
    const gates = await getPromotionGates()
    if (gates.enabled) {
      const promo = evaluatePromotion(metrics, gates, { folds: [] })
      if (!promo.passed) {
        for (const f of promo.failures || []) failures.push(`gate: ${f}`)
      }
    }
  }

  const passed = failures.length === 0
  const blocked = !passed && policy.mode === "block"
  const note = passed
    ? "Pre-signal validation passed"
    : blocked
      ? `Pre-signal validation blocked: ${failures.join("; ")}`
      : `Pre-signal validation warning: ${failures.join("; ")}`

  try {
    await writeAudit({
      userId,
      action: blocked
        ? "pre_signal.blocked"
        : passed
          ? "pre_signal.passed"
          : "pre_signal.warned",
      resource: "Strategy",
      resourceId: strategyId,
      summary: note,
      meta: {
        pair,
        failures,
        metrics,
        backtestRunId,
        backtestError,
        mode: policy.mode,
      },
    })
  } catch {
    /* non-fatal */
  }

  return {
    ok: passed,
    blocked,
    mode: policy.mode,
    note,
    failures,
    metrics,
    backtestRunId,
    backtestError,
    policy,
  }
}
