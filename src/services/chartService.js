import crypto from "crypto"
import { getUpcomingEvents, estimateNewsImpactPips } from "./newsFilterEngine.js"
import Trade from "../models/Trade.js"
import Strategy from "../models/Strategy.js"

const PAIR_BASE = {
  EURUSD: 1.085,
  GBPUSD: 1.265,
  USDJPY: 149.5,
  AUDUSD: 0.655,
  USDCAD: 1.365,
  USDCHF: 0.885,
  NZDUSD: 0.605,
  EURGBP: 0.858,
  EURJPY: 162.2,
  GBPJPY: 189.1,
  XAUUSD: 2350,
  XAGUSD: 28.5,
}

const TF_SECONDS = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic synthetic OHLC for workspace demos when no market data vendor is configured.
 * Seeded by pair+timeframe so reloads are stable.
 */
export function generateCandles({ pair = "EURUSD", timeframe = "M15", count = 200 } = {}) {
  const p = String(pair).toUpperCase()
  const base = PAIR_BASE[p] || 1.1
  const sec = TF_SECONDS[timeframe] || 900
  const now = Math.floor(Date.now() / 1000)
  const aligned = now - (now % sec)
  const seed = parseInt(
    crypto.createHash("md5").update(`${p}:${timeframe}`).digest("hex").slice(0, 8),
    16
  )
  const rnd = mulberry32(seed)

  const volatility =
    p.includes("XAU") ? 2.5 : p.includes("JPY") ? 0.08 : p.includes("XAG") ? 0.15 : 0.00035

  let price = base * (0.98 + rnd() * 0.04)
  const candles = []

  for (let i = count - 1; i >= 0; i--) {
    const time = aligned - i * sec
    const drift = (rnd() - 0.48) * volatility
    const open = price
    const close = open + drift
    const high = Math.max(open, close) + rnd() * volatility * 0.6
    const low = Math.min(open, close) - rnd() * volatility * 0.6
    candles.push({
      time,
      open: Number(open.toFixed(p.includes("JPY") || p.includes("XAU") ? 3 : 5)),
      high: Number(high.toFixed(p.includes("JPY") || p.includes("XAU") ? 3 : 5)),
      low: Number(low.toFixed(p.includes("JPY") || p.includes("XAU") ? 3 : 5)),
      close: Number(close.toFixed(p.includes("JPY") || p.includes("XAU") ? 3 : 5)),
    })
    price = close
  }

  return {
    pair: p,
    timeframe,
    source: process.env.MARKET_DATA_URL ? "vendor" : "synthetic",
    candles,
    last: candles[candles.length - 1],
  }
}

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

  // Always show a sample historical high-impact marker near the middle of the series for UI demo
  if (candles?.length > 20) {
    const mid = candles[Math.floor(candles.length * 0.7)]
    markers.push({
      id: `hist-cpi-${mid.time}`,
      time: mid.time,
      label: "CPI (hist)",
      impact: "high",
      estimatedPips: estimateNewsImpactPips(pair, "CPI"),
      kind: "news",
      withinChart: true,
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

export async function getWorkspaceBundle(userId, query) {
  const pair = (query.pair || "EURUSD").toUpperCase()
  const timeframe = query.timeframe || "M15"
  const count = Math.min(Number(query.count) || 200, 500)
  const strategyId = query.strategyId || null

  const series = generateCandles({ pair, timeframe, count })
  const newsMarkers = buildNewsImpactMarkers(pair, series.candles)
  const overlays = await buildTradeOverlays(userId, { pair, strategyId })
  const strategyLevels = await buildStrategyLevels(userId, strategyId)

  return {
    ...series,
    newsMarkers,
    overlays,
    strategyLevels,
    generatedAt: new Date().toISOString(),
  }
}
