import { generateCandles as syntheticCandles } from "./chartServiceSynthetic.js"
import AdminSettings from "../models/AdminSettings.js"

const TF_MAP_TWELVE = {
  M1: "1min",
  M5: "5min",
  M15: "15min",
  M30: "30min",
  H1: "1h",
  H4: "4h",
  D1: "1day",
}

const TF_MAP_FINNHUB = {
  M1: "1",
  M5: "5",
  M15: "15",
  M30: "30",
  H1: "60",
  H4: "60",
  D1: "D",
}

async function safeParseResponse(res) {
  const text = await res.text()
  if (!text?.trim()) return null
  const t = text.trim()
  if (t === "Restricted" || /^Restricted/i.test(t) || t.startsWith("<")) {
    console.warn("[marketData] Vendor returned restricted/non-JSON payload")
    return null
  }
  try {
    return JSON.parse(t)
  } catch {
    console.warn("[marketData] Invalid JSON from vendor")
    return null
  }
}

async function getProvider() {
  try {
    const s = await AdminSettings.findOne()
    return s?.marketDataProvider || process.env.MARKET_DATA_PROVIDER || "twelvedata"
  } catch {
    return process.env.MARKET_DATA_PROVIDER || "twelvedata"
  }
}

function toUnixBars(candles) {
  return candles.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }))
}

async function fetchTwelveData(pair, timeframe, count) {
  const key = process.env.TWELVEDATA_API_KEY
  if (!key) return null
  const interval = TF_MAP_TWELVE[timeframe] || "15min"
  const symbol = pair.includes("XAU") ? "XAU/USD" : pair.includes("XAG") ? "XAG/USD" : `${pair.slice(0, 3)}/${pair.slice(3)}`
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${Math.min(count, 500)}&apikey=${key}`
  const res = await fetch(url)
  const data = await safeParseResponse(res)
  if (!data || data.status === "error" || !data.values) {
    if (data) console.warn("[twelvedata]", data.message || data)
    return null
  }
  const candles = data.values
    .map((v) => ({
      time: Math.floor(new Date(v.datetime).getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .reverse()
  return { pair, timeframe, source: "twelvedata", candles, last: candles[candles.length - 1] }
}

async function fetchFinnhub(pair, timeframe, count) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  const resolution = TF_MAP_FINNHUB[timeframe] || "15"
  const to = Math.floor(Date.now() / 1000)
  // approximate lookback
  const secPerBar = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 }[timeframe] || 900
  const from = to - secPerBar * Math.min(count, 500) * 1.2
  const symbol = `OANDA:${pair.slice(0, 3)}_${pair.slice(3)}`
  const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${Math.floor(from)}&to=${to}&token=${key}`
  const res = await fetch(url)
  const data = await safeParseResponse(res)
  if (!data || data.s !== "ok" || !data.t?.length) {
    if (data) console.warn("[finnhub candles]", data.s || data)
    return null
  }
  const candles = data.t.map((t, i) => ({
    time: t,
    open: data.o[i],
    high: data.h[i],
    low: data.l[i],
    close: data.c[i],
  }))
  return { pair, timeframe, source: "finnhub", candles, last: candles[candles.length - 1] }
}

/**
 * Prefer live vendor OHLC; fall back to deterministic synthetic only if both fail / no keys.
 */
export async function getCandles({ pair = "EURUSD", timeframe = "M15", count = 200 } = {}) {
  const p = String(pair).toUpperCase()
  const provider = await getProvider()
  try {
    if (provider === "finnhub") {
      const f = await fetchFinnhub(p, timeframe, count)
      if (f?.candles?.length) return f
      const t = await fetchTwelveData(p, timeframe, count)
      if (t?.candles?.length) return t
    } else {
      const t = await fetchTwelveData(p, timeframe, count)
      if (t?.candles?.length) return t
      const f = await fetchFinnhub(p, timeframe, count)
      if (f?.candles?.length) return f
    }
  } catch (err) {
    console.error("[marketData]", err.message)
  }
  const syn = syntheticCandles({ pair: p, timeframe, count })
  return { ...syn, source: "synthetic_fallback" }
}

export function marketDataKeysStatus() {
  return {
    twelvedata: Boolean(process.env.TWELVEDATA_API_KEY),
    finnhub: Boolean(process.env.FINNHUB_API_KEY),
  }
}
