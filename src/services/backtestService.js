import Strategy from "../models/Strategy.js"
import BacktestRun from "../models/BacktestRun.js"
import { getCandles } from "./marketDataService.js"
import { applyBacktestMetrics } from "./strategyMetricsService.js"

/**
 * Rule-based backtest on OHLC series using strategy rules + structure heuristics.
 * Supports full-history and walk-forward folds.
 */

function parseLevel(val, fallback = null) {
  if (val == null || val === "") return fallback
  const n = Number(String(val).replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) ? n : fallback
}

function extractRules(strategy) {
  const rules = strategy.rules || {}
  const plotted = strategy.plottedLevels || {}
  return {
    direction: rules.direction || "long_short",
    minRR: parseLevel(rules.minRR, 2) || 2,
    entryHint: rules.entry || "",
    slHint: rules.stopLoss || "",
    tpHint: rules.takeProfit || "",
    plottedEntry: parseLevel(plotted.entry),
    plottedSL: parseLevel(plotted.stopLoss),
    plottedTP: parseLevel(plotted.takeProfit),
  }
}

/**
 * Simple structure: long when close > SMA and bullish candle after dip;
 * short when close < SMA and bearish after bounce. SL/TP from ATR-like range.
 */
function simulateOnCandles(candles, { direction, minRR, riskPercent, initialBalance }) {
  const trades = []
  let balance = initialBalance
  let peak = balance
  let maxDD = 0
  const equityCurve = []
  let position = null

  const period = 20
  for (let i = period; i < candles.length; i++) {
    const window = candles.slice(i - period, i)
    const sma = window.reduce((s, c) => s + c.close, 0) / period
    const c = candles[i]
    const prev = candles[i - 1]
    const range =
      window.reduce((s, x) => s + (x.high - x.low), 0) / period || c.close * 0.001

    // mark equity
    let equity = balance
    if (position) {
      const mark = c.close
      const floating =
        position.direction === "long"
          ? (mark - position.entry) * position.units
          : (position.entry - mark) * position.units
      equity = balance + floating
    }
    peak = Math.max(peak, equity)
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0
    maxDD = Math.max(maxDD, dd)
    equityCurve.push({ bar: i, equity: Number(equity.toFixed(2)) })

    // manage open
    if (position) {
      let exit = null
      let reason = ""
      if (position.direction === "long") {
        if (c.low <= position.sl) {
          exit = position.sl
          reason = "sl"
        } else if (c.high >= position.tp) {
          exit = position.tp
          reason = "tp"
        }
      } else {
        if (c.high >= position.sl) {
          exit = position.sl
          reason = "sl"
        } else if (c.low <= position.tp) {
          exit = position.tp
          reason = "tp"
        }
      }
      if (exit != null) {
        const pnl =
          position.direction === "long"
            ? (exit - position.entry) * position.units
            : (position.entry - exit) * position.units
        balance += pnl
        trades.push({
          bar: i,
          direction: position.direction,
          entry: position.entry,
          exit,
          pnl: Number(pnl.toFixed(2)),
          reason,
        })
        position = null
      }
      continue
    }

    // entries
    const allowLong = direction === "long" || direction === "long_short"
    const allowShort = direction === "short" || direction === "long_short"
    const bullish = c.close > c.open && prev.close < prev.open && c.close > sma
    const bearish = c.close < c.open && prev.close > prev.open && c.close < sma

    if (allowLong && bullish) {
      const entry = c.close
      const sl = entry - range * 1.2
      const riskDist = entry - sl
      const tp = entry + riskDist * minRR
      const riskAmt = balance * (riskPercent / 100)
      const units = riskDist > 0 ? riskAmt / riskDist : 0
      if (units > 0) position = { direction: "long", entry, sl, tp, units }
    } else if (allowShort && bearish) {
      const entry = c.close
      const sl = entry + range * 1.2
      const riskDist = sl - entry
      const tp = entry - riskDist * minRR
      const riskAmt = balance * (riskPercent / 100)
      const units = riskDist > 0 ? riskAmt / riskDist : 0
      if (units > 0) position = { direction: "short", entry, sl, tp, units }
    }
  }

  // force close at end
  if (position) {
    const last = candles[candles.length - 1]
    const exit = last.close
    const pnl =
      position.direction === "long"
        ? (exit - position.entry) * position.units
        : (position.entry - exit) * position.units
    balance += pnl
    trades.push({
      bar: candles.length - 1,
      direction: position.direction,
      entry: position.entry,
      exit,
      pnl: Number(pnl.toFixed(2)),
      reason: "eod",
    })
  }

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl <= 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0
  const avgWin = wins.length ? grossWin / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  const expectancy =
    trades.length && avgLoss > 0
      ? (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss
      : avgWin
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(2)),
    expectancy: Number(expectancy.toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(2)),
    maxDrawdownPercent: Number(maxDD.toFixed(2)),
    netProfit: Number((balance - initialBalance).toFixed(2)),
    finalBalance: Number(balance.toFixed(2)),
    equityCurve: equityCurve.filter((_, idx) => idx % 5 === 0 || idx === equityCurve.length - 1),
    tradeList: trades.slice(-100),
  }
}

export async function runBacktest(userId, payload) {
  const {
    strategyId,
    pair = "EURUSD",
    timeframe = "H1",
    mode = "historical",
    riskPerTradePercent = 1,
    initialBalance = 10000,
    candleCount = 500,
    trainBars = 200,
    testBars = 100,
    minRR: payloadMinRR,
    maxFolds = 12,
  } = payload

  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    throw Object.assign(new Error("Strategy not found"), { status: 404 })
  }

  const run = await BacktestRun.create({
    userId,
    strategyId,
    pair: String(pair).toUpperCase(),
    timeframe,
    mode: mode === "walk_forward" ? "walk_forward" : "historical",
    params: {
      riskPerTradePercent,
      initialBalance,
      trainBars,
      testBars,
      candleCount: Math.min(Number(candleCount) || 500, 2000),
    },
    status: "running",
  })

  try {
    const series = await getCandles({
      pair: run.pair,
      timeframe,
      count: run.params.candleCount,
    })
    const candles = series.candles
    const rules = extractRules(strategy)
    const simOpts = {
      direction: rules.direction,
      minRR: Number(payloadMinRR || strategy.designatedRR || rules.minRR || 2),
      riskPercent: riskPerTradePercent,
      initialBalance,
    }

    let results
    if (run.mode === "walk_forward") {
      const folds = []
      let offset = 0
      const train = Number(trainBars) || 200
      const test = Number(testBars) || 100
      let fold = 0
      while (offset + train + test <= candles.length && fold < 8) {
        const slice = candles.slice(offset, offset + train + test)
        // simulate only on test segment for metrics
        const testSlice = candles.slice(offset + train, offset + train + test)
        const foldResult = simulateOnCandles(testSlice, simOpts)
        folds.push({
          fold: fold + 1,
          trainBars: train,
          testBars: testSlice.length,
          trades: foldResult.trades,
          winRate: foldResult.winRate,
          netProfit: foldResult.netProfit,
          maxDrawdownPercent: foldResult.maxDrawdownPercent,
        })
        offset += test
        fold++
      }
      // overall on full series
      const overall = simulateOnCandles(candles, simOpts)
      results = {
        ...overall,
        walkForwardFolds: folds,
      }
    } else {
      results = {
        ...simulateOnCandles(candles, simOpts),
        walkForwardFolds: [],
      }
    }

    // RR analytics on simulated trades
    const designatedRR = Number(
      strategy.designatedRR || strategy.rules?.minRR || simOpts.minRR || 2
    )
    const winTrades = (results.tradeList || []).filter((t) => t.pnl > 0)
    const tpHits = winTrades.filter((t) => t.reason === "tp").length
    results.avgRealizedRR = winTrades.length
      ? Number(
          (
            winTrades.reduce(
              (s, t) => s + (t.reason === "tp" ? designatedRR : designatedRR * 0.6),
              0
            ) / winTrades.length
          ).toFixed(2)
        )
      : 0
    results.designatedRRHitRate = winTrades.length
      ? Number(((tpHits / winTrades.length) * 100).toFixed(2))
      : 0
    results.highProbabilityRR = results.designatedRRHitRate >= 50 ? designatedRR : Number((designatedRR * 0.75).toFixed(2))
    results.designatedRR = designatedRR

    run.status = "completed"
    run.results = results
    run.completedAt = new Date()
    await run.save()

    await applyBacktestMetrics(strategy, results)

    return run
  } catch (err) {
    run.status = "failed"
    run.errorMessage = err.message
    run.completedAt = new Date()
    await run.save()
    throw err
  }
}

export async function listBacktests(userId, { strategyId, limit = 30 } = {}) {
  const q = { userId }
  if (strategyId) q.strategyId = strategyId
  return BacktestRun.find(q).sort({ createdAt: -1 }).limit(limit)
}

export async function getBacktest(userId, id) {
  const run = await BacktestRun.findOne({ _id: id, userId })
  if (!run) throw Object.assign(new Error("Backtest not found"), { status: 404 })
  return run
}
