import Strategy from "../models/Strategy.js"
import AdminSettings from "../models/AdminSettings.js"
import User from "../models/User.js"
import { getCandles } from "./marketDataService.js"
import {
  callOpenRouterVision,
  extractJsonFromText,
  DEFAULT_FREE_MODEL,
} from "./openrouter.js"
import { writeAudit } from "./auditService.js"
import redis from "../config/redis.js"

const DEFAULT_POLICY = {
  enabled: true,
  cooldownSeconds: 120,
  cacheTtlSeconds: 900,
  maxPerHour: 10,
  defaultTimeframe: "M15",
  candleCount: 80,
}

function cacheKey(userId, pair, timeframe, strategyId) {
  return `ai_chart:${userId}:${String(pair).toUpperCase()}:${timeframe}:${strategyId || "none"}`
}

function rateKey(userId) {
  return `ai_chart_rate:${userId}`
}

export async function resolveAiChartPolicy(userId) {
  const [settings, user] = await Promise.all([
    AdminSettings.findOne(),
    User.findById(userId).select("preferences modelPreference"),
  ])
  const global = settings?.aiChartAssist || {}
  const userPref = user?.preferences?.aiChartAssist || {}
  const globalEnabled = settings?.globalFeatureToggles?.aiChartAssist !== false

  return {
    enabled: globalEnabled && userPref.enabled !== false,
    cooldownSeconds: Number(
      userPref.cooldownSeconds || global.cooldownSeconds || DEFAULT_POLICY.cooldownSeconds
    ),
    cacheTtlSeconds: Number(global.cacheTtlSeconds || DEFAULT_POLICY.cacheTtlSeconds),
    maxPerHour: Number(global.maxPerHour || DEFAULT_POLICY.maxPerHour),
    modelId:
      userPref.modelId ||
      user?.modelPreference ||
      settings?.defaultFreeModelId ||
      DEFAULT_FREE_MODEL,
    candleCount: Number(global.candleCount || DEFAULT_POLICY.candleCount),
  }
}

async function checkRateLimit(userId, policy) {
  try {
    const key = rateKey(userId)
    const raw = await redis.get(key)
    const data = raw ? JSON.parse(raw) : { count: 0, window: Date.now() }
    if (Date.now() - data.window > 3600_000) {
      data.count = 0
      data.window = Date.now()
    }
    if (data.count >= policy.maxPerHour) {
      return {
        ok: false,
        note: `Hourly AI chart limit reached (${policy.maxPerHour}/hour)`,
      }
    }
    data.count += 1
    await redis.setex(key, 3600, JSON.stringify(data))
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

function summarizeCandles(candles) {
  if (!candles?.length) return "No candles"
  const last = candles[candles.length - 1]
  const first = candles[0]
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const closes = candles.map((c) => c.close)
  const maxH = Math.max(...highs)
  const minL = Math.min(...lows)
  const recent = candles.slice(-12).map((c) => ({
    t: c.time,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }))
  return {
    firstTime: first.time,
    lastTime: last.time,
    lastClose: last.close,
    rangeHigh: maxH,
    rangeLow: minL,
    change: Number((last.close - first.close).toFixed(5)),
    recent,
  }
}

function offlineAnnotation(pair, summary, strategy) {
  const mid = (summary.rangeHigh + summary.rangeLow) / 2
  const plotted = strategy?.plottedLevels || {}
  return {
    offline: true,
    summary: `Offline annotation for ${pair}. Last ${summary.lastClose}. Range ${summary.rangeLow}–${summary.rangeHigh}.`,
    bias: summary.change >= 0 ? "bullish" : "bearish",
    confidence: 40,
    levels: {
      entry: plotted.entry ? Number(plotted.entry) : Number(summary.lastClose.toFixed(5)),
      stopLoss: plotted.stopLoss
        ? Number(plotted.stopLoss)
        : Number((summary.rangeLow * 0.999).toFixed(5)),
      takeProfit: plotted.takeProfit
        ? Number(plotted.takeProfit)
        : Number((summary.rangeHigh * 1.001).toFixed(5)),
      support: Number(summary.rangeLow.toFixed(5)),
      resistance: Number(summary.rangeHigh.toFixed(5)),
      pivot: Number(mid.toFixed(5)),
    },
    notes: [
      "OPENROUTER_API_KEY missing or model unavailable — deterministic fallback used.",
      `Strategy required: ${strategy.name}`,
    ],
    patterns: [],
  }
}

export async function getCachedAnnotation(userId, { pair, timeframe, strategyId }) {
  try {
    const key = cacheKey(userId, pair, timeframe, strategyId)
    const raw = await redis.get(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * On-demand AI chart annotation (not every tick).
 * Uses OHLC summary + optional strategy rules; OpenRouter text/vision-capable model.
 */
export async function annotateChart(userId, { pair, timeframe = "M15", strategyId, force = false }) {
  const policy = await resolveAiChartPolicy(userId)
  if (!policy.enabled) {
    return {
      ok: false,
      status: 403,
      message: "AI chart assist is disabled by admin or user preferences",
    }
  }

  if (!strategyId) {
    return {
      ok: false,
      status: 400,
      message: "A strategy is required for AI chart assist — select one of your strategies",
    }
  }

  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    return {
      ok: false,
      status: 404,
      message: "Strategy not found for this account",
    }
  }
  if (["draft", "disabled", "archived"].includes(strategy.status)) {
    return {
      ok: false,
      status: 400,
      message: "Strategy must be review/approved/demo/live (not draft, disabled, or archived)",
    }
  }

  const pairU = String(pair || "EURUSD").toUpperCase()
  const tf = timeframe || "M15"

  if (!force) {
    const cached = await getCachedAnnotation(userId, {
      pair: pairU,
      timeframe: tf,
      strategyId,
    })
    if (cached) {
      return { ok: true, cached: true, annotation: cached }
    }
  }

  const rate = await checkRateLimit(userId, policy)
  if (!rate.ok) {
    return { ok: false, status: 429, message: rate.note }
  }

  const series = await getCandles({
    pair: pairU,
    timeframe: tf,
    count: policy.candleCount,
  })
  const summary = summarizeCandles(series.candles)

  const systemPrompt = `You are a disciplined forex chart analyst for Altra-AuraTrade.
Return ONLY valid JSON with keys:
summary (string), bias (bullish|bearish|neutral), confidence (0-100),
levels: { entry, stopLoss, takeProfit, support, resistance, pivot } as numbers or null,
notes: string[], patterns: string[].
You MUST apply the user strategy rules and plotted levels as the primary decision framework. Do not invent a conflicting system. Prefer positive expectancy and clear invalidation (SL).`

  const userText = `Pair: ${pairU}
Timeframe: ${tf}
OHLC summary: ${JSON.stringify(summary)}
Strategy name: ${strategy.name}
Strategy status: ${strategy.status}
Strategy rules (AUTHORITATIVE): ${JSON.stringify(strategy.rules || {})}
Strategy plotted levels (AUTHORITATIVE): ${JSON.stringify(strategy.plottedLevels || {})}
Designated RR: ${strategy.designatedRR || strategy.rules?.minRR || 2}
Analyze structure ONLY through this strategy. Propose levels consistent with the strategy.`

  let annotation
  const visionRes = await callOpenRouterVision({
    modelId: policy.modelId,
    systemPrompt,
    userText,
    imageDataUrls: [],
  })

  if (!visionRes.ok) {
    annotation = offlineAnnotation(pairU, summary, strategy)
    annotation.modelError = visionRes.error
    annotation.model = policy.modelId
  } else {
    const parsed = extractJsonFromText(visionRes.content) || {}
    annotation = {
      offline: false,
      summary: parsed.summary || visionRes.content?.slice(0, 400) || "Annotation complete",
      bias: parsed.bias || "neutral",
      confidence: Number(parsed.confidence) || 50,
      levels: parsed.levels || {},
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      model: visionRes.model || policy.modelId,
      usage: visionRes.usage || null,
    }
  }

  annotation.pair = pairU
  annotation.timeframe = tf
  annotation.strategyId = strategy._id
  annotation.strategyName = strategy.name
  annotation.candleSource = series.source
  annotation.lastClose = summary.lastClose
  annotation.createdAt = new Date().toISOString()
  annotation.expiresAt = new Date(
    Date.now() + policy.cacheTtlSeconds * 1000
  ).toISOString()

  try {
    await redis.setex(
      cacheKey(userId, pairU, tf, strategyId),
      policy.cacheTtlSeconds,
      JSON.stringify(annotation)
    )
  } catch {
    /* redis optional */
  }

  try {
    await writeAudit({
      userId,
      action: "ai_chart.annotate",
      resource: "Chart",
      resourceId: strategyId || null,
      summary: `AI chart assist ${pairU} ${tf}${annotation.offline ? " (offline)" : ""}`,
      meta: { bias: annotation.bias, confidence: annotation.confidence, model: annotation.model },
    })
  } catch {
    /* */
  }

  return { ok: true, cached: false, annotation, policy: { cooldownSeconds: policy.cooldownSeconds } }
}
