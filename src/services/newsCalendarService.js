import AdminSettings from "../models/AdminSettings.js"
import redis from "../config/redis.js"

/**
 * Economic calendar providers (priority by admin setting):
 * 1) financecalendar — https://www.financecalendar.com (X-API-Key)
 * 2) jbnews — JBlanked https://www.jblanked.com (Authorization: Api-Key)
 * Fallbacks: finnhub, fmp (legacy)
 *
 * Redis cache (default 10 min) protects free-tier rate limits.
 */

const CACHE_TTL_SEC = Number(process.env.NEWS_CALENDAR_CACHE_TTL || 600)

function dateStr(d) {
  return d.toISOString().slice(0, 10)
}

async function getNewsProvider() {
  try {
    const s = await AdminSettings.findOne()
    return (
      s?.newsDataProvider ||
      process.env.NEWS_DATA_PROVIDER ||
      "financecalendar"
    )
  } catch {
    return process.env.NEWS_DATA_PROVIDER || "financecalendar"
  }
}

async function safeJson(res) {
  const text = await res.text()
  if (!text?.trim()) return null
  const t = text.trim()
  if (t === "Restricted" || /^Restricted/i.test(t) || t.startsWith("<")) {
    return { __restricted: true, raw: t.slice(0, 120) }
  }
  try {
    return JSON.parse(t)
  } catch {
    return { __invalid: true, raw: t.slice(0, 120) }
  }
}

function normalizeImpact(v) {
  const s = String(v ?? "medium").toLowerCase()
  if (s.includes("high") || s === "3" || s === "red") return "high"
  if (s.includes("low") || s === "1" || s === "yellow") return "low"
  return "medium"
}

function parseFlexibleDate(raw) {
  if (raw == null || raw === "") return null
  if (typeof raw === "number") {
    const ms = raw > 1e12 ? raw : raw * 1000
    return new Date(ms).toISOString()
  }
  const s = String(raw).trim()
  // JBlanked style: 2024.02.08 15:30:00
  const dotted = s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3")
  const d = new Date(dotted)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return null
}

/** Finance Calendar — official REST */
async function fetchFinanceCalendar(from, to) {
  const key = process.env.FINANCECALENDAR_API_KEY || process.env.FC_API_KEY
  if (!key) return null
  try {
    // Prefer week + next week for coverage; also try calendar range
    const urls = [
      `https://www.financecalendar.com/wp-json/fc/v1/week?impact=high,medium&tz=UTC`,
      `https://www.financecalendar.com/wp-json/fc/v1/week?week=next&impact=high,medium&tz=UTC`,
      `https://www.financecalendar.com/wp-json/fc/v1/calendar?country=US,EU,GB,JP,CA,AU,CH,NZ&impact=high,medium&tz=UTC`,
    ]
    const headers = {
      "X-API-Key": key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    }
    const merged = []
    const seen = new Set()
    for (const url of urls) {
      const res = await fetch(url, { headers })
      if (res.status === 401 || res.status === 403) {
        console.warn("[newsCalendar] Finance Calendar auth failed:", res.status)
        return null
      }
      if (res.status === 429) {
        console.warn("[newsCalendar] Finance Calendar rate limited")
        break
      }
      const data = await safeJson(res)
      if (!data || data.__restricted || data.__invalid) continue
      const list = Array.isArray(data.events)
        ? data.events
        : Array.isArray(data)
          ? data
          : []
      for (const e of list) {
        const id = e.id || `${e.name}-${e.time_utc || e.date}`
        if (seen.has(id)) continue
        seen.add(id)
        const time = parseFlexibleDate(e.time_utc || e.time || e.date)
        if (!time) continue
        merged.push({
          id: `fc-${id}`,
          name: e.name || e.title || "Economic event",
          country: e.country || e.currency || "",
          impact: normalizeImpact(e.impact),
          time,
          actual: e.actual ?? null,
          estimate: e.consensus ?? e.forecast ?? e.estimate ?? null,
          prev: e.prior ?? e.previous ?? e.prev ?? null,
          source: "financecalendar",
        })
      }
    }
    // filter to requested window when possible
    const fromMs = new Date(from).getTime()
    const toMs = new Date(to).getTime() + 86400000
    const filtered = merged.filter((e) => {
      const t = new Date(e.time).getTime()
      return t >= fromMs - 86400000 && t <= toMs
    })
    return filtered.length ? filtered : merged.length ? merged : null
  } catch (err) {
    console.warn("[newsCalendar] Finance Calendar:", err.message)
    return null
  }
}

/** JBlanked / JB News */
async function fetchJbNews(from, to) {
  const key = process.env.JBNEWS_API_KEY || process.env.JBLANKED_API_KEY
  if (!key) return null
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Api-Key ${key}`,
  }
  const base = "https://www.jblanked.com/news/api"
  const sources = ["mql5", "forex-factory"]
  try {
    const merged = []
    const seen = new Set()
    for (const src of sources) {
      const urls = [
        `${base}/${src}/calendar/week/`,
        `${base}/${src}/calendar/today/`,
        `${base}/${src}/calendar/range/?from=${from}&to=${to}`,
      ]
      for (const url of urls) {
        try {
          const res = await fetch(url, { headers })
          if (res.status === 401 || res.status === 403) {
            console.warn("[newsCalendar] JB News auth failed:", res.status)
            return null
          }
          if (!res.ok) continue
          const data = await safeJson(res)
          if (!data || data.__restricted || data.__invalid) continue
          const list = Array.isArray(data) ? data : data.events || data.results || []
          if (!Array.isArray(list)) continue
          for (const e of list) {
            const name = e.Name || e.name || e.title || "Economic event"
            const time = parseFlexibleDate(e.Date || e.date || e.time)
            if (!time) continue
            const id = `jb-${src}-${name}-${time}`
            if (seen.has(id)) continue
            seen.add(id)
            merged.push({
              id,
              name,
              country: e.Currency || e.currency || e.country || "",
              impact: normalizeImpact(e.Impact || e.impact),
              time,
              actual: e.Actual ?? e.actual ?? null,
              estimate: e.Forecast ?? e.forecast ?? null,
              prev: e.Previous ?? e.previous ?? e.prev ?? null,
              source: `jbnews:${src}`,
              trend: e.Trend || e.trend || null,
            })
          }
        } catch {
          /* try next url */
        }
      }
      if (merged.length) break // one successful source is enough
    }
    return merged.length ? merged : null
  } catch (err) {
    console.warn("[newsCalendar] JB News:", err.message)
    return null
  }
}

async function fetchFinnhubCalendar(from, to) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`
    const res = await fetch(url)
    const data = await safeJson(res)
    if (!data || data.__restricted || data.__invalid) return null
    const list = data.economicCalendar || (Array.isArray(data) ? data : [])
    if (!Array.isArray(list) || !list.length) return null
    return list.map((e, i) => ({
      id: `fh-${e.event || e.eventName}-${e.time || e.date}-${i}`,
      name: e.event || e.eventName || "Economic event",
      country: e.country || e.countryCode || "",
      impact: normalizeImpact(e.impact || e.importance),
      time: parseFlexibleDate(
        typeof e.time === "number" ? e.time : e.time || e.date
      ),
      actual: e.actual,
      estimate: e.estimate,
      prev: e.prev,
      source: "finnhub",
    })).filter((e) => e.time)
  } catch (err) {
    console.warn("[newsCalendar] Finnhub:", err.message)
    return null
  }
}

async function fetchFmpCalendar(from, to) {
  const key = process.env.FMP_API_KEY
  if (!key) return null
  try {
    const url = `https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${key}`
    const res = await fetch(url)
    const data = await safeJson(res)
    if (!data || data.__restricted || data.__invalid) return null
    if (data["Error Message"] || data.error) return null
    const list = Array.isArray(data) ? data : data.data
    if (!Array.isArray(list) || !list.length) return null
    return list.map((e, i) => ({
      id: `fmp-${e.event || e.eventName}-${e.date}-${i}`,
      name: e.event || e.eventName || "Economic event",
      country: e.country || e.currency || "",
      impact: normalizeImpact(e.impact || e.importance),
      time: parseFlexibleDate(e.date || e.time),
      actual: e.actual,
      estimate: e.estimate,
      prev: e.previous || e.prev,
      source: "fmp",
    })).filter((e) => e.time)
  } catch (err) {
    console.warn("[newsCalendar] FMP:", err.message)
    return null
  }
}

async function readCache(key) {
  try {
    if (!redis) return null
    const raw = await redis.get(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function writeCache(key, value) {
  try {
    if (!redis) return
    await redis.setex(key, CACHE_TTL_SEC, JSON.stringify(value))
  } catch {
    /* optional */
  }
}

export async function getEconomicCalendar({ days = 7 } = {}) {
  const from = dateStr(new Date())
  const toDate = new Date()
  toDate.setDate(toDate.getDate() + days)
  const to = dateStr(toDate)
  const provider = await getNewsProvider()
  const cacheKey = `news:calendar:${provider}:${from}:${to}`

  const cached = await readCache(cacheKey)
  if (cached?.events) {
    return { ...cached, cached: true }
  }

  const order =
    provider === "jbnews"
      ? ["jbnews", "financecalendar", "finnhub", "fmp"]
      : provider === "finnhub"
        ? ["finnhub", "financecalendar", "jbnews", "fmp"]
        : provider === "fmp"
          ? ["fmp", "financecalendar", "jbnews", "finnhub"]
          : ["financecalendar", "jbnews", "finnhub", "fmp"]

  const fetchers = {
    financecalendar: () => fetchFinanceCalendar(from, to),
    jbnews: () => fetchJbNews(from, to),
    finnhub: () => fetchFinnhubCalendar(from, to),
    fmp: () => fetchFmpCalendar(from, to),
  }

  for (const name of order) {
    try {
      const events = await fetchers[name]()
      if (events?.length) {
        const payload = {
          events: events.sort((a, b) => new Date(a.time) - new Date(b.time)),
          source: name,
          from,
          to,
          cached: false,
        }
        await writeCache(cacheKey, payload)
        return payload
      }
    } catch (err) {
      console.warn(`[newsCalendar] ${name}:`, err.message)
    }
  }

  return {
    events: [],
    source: "none",
    from,
    to,
    cached: false,
    message:
      "No live calendar data. Set FINANCECALENDAR_API_KEY and/or JBNEWS_API_KEY in backend .env, pick provider in Admin → Settings. Data: financecalendar.com · jblanked.com",
  }
}

export async function getUpcomingHighImpact(withinMinutes = 120) {
  const { events, source } = await getEconomicCalendar({ days: 3 })
  const now = Date.now()
  const end = now + withinMinutes * 60 * 1000
  const filtered = events.filter((e) => {
    const t = new Date(e.time).getTime()
    if (Number.isNaN(t)) return false
    return e.impact === "high" && t >= now - 15 * 60 * 1000 && t <= end
  })
  return { events: filtered, source }
}

export function newsKeysStatus() {
  return {
    financecalendar: Boolean(
      process.env.FINANCECALENDAR_API_KEY || process.env.FC_API_KEY
    ),
    jbnews: Boolean(process.env.JBNEWS_API_KEY || process.env.JBLANKED_API_KEY),
    finnhub: Boolean(process.env.FINNHUB_API_KEY),
    fmp: Boolean(process.env.FMP_API_KEY),
  }
}
