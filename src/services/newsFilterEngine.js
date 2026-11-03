import { getUpcomingHighImpact } from "./newsCalendarService.js"

const IMPACT_PIPS = {
  FOMC: 80,
  CPI: 60,
  NFP: 70,
  GDP: 40,
  ECB: 50,
  BOE: 45,
  DEFAULT: 30,
}

export function estimateNewsImpactPips(pair, eventName = "") {
  const key = Object.keys(IMPACT_PIPS).find((k) =>
    String(eventName).toUpperCase().includes(k)
  )
  return IMPACT_PIPS[key] || IMPACT_PIPS.DEFAULT
}

/** Sync helper for charts — uses last fetched cache if any */
let _cache = { at: 0, events: [] }

export function getUpcomingEvents(withinMinutes = 120) {
  // synchronous fallback for chart markers: use cache
  const now = Date.now()
  return (_cache.events || []).filter((e) => {
    const t = new Date(e.time).getTime()
    return t >= now - 15 * 60 * 1000 && t <= now + withinMinutes * 60 * 1000
  })
}

export async function refreshNewsCache() {
  try {
    const { events } = await getUpcomingHighImpact(24 * 60)
    _cache = { at: Date.now(), events: events.map((e) => ({ name: e.name, time: e.time, impact: e.impact })) }
  } catch {
    /* ignore */
  }
}

export async function evaluateNewsFilterAsync({ isNewsFilterEnabled = true, newsFilters = [], pair } = {}) {
  if (!isNewsFilterEnabled) {
    return { blocked: false, reason: null, note: "News filter disabled on account" }
  }
  await refreshNewsCache()
  const upcoming = getUpcomingEvents(120)
  const watch = (newsFilters || []).map((x) => String(x).toUpperCase())
  const hit = upcoming.find((e) => {
    const name = String(e.name).toUpperCase()
    if (!watch.length) return true
    return watch.some((w) => name.includes(w))
  })
  if (hit) {
    return {
      blocked: true,
      reason: "news_window",
      note: `High-impact window: ${hit.name} (~${estimateNewsImpactPips(pair, hit.name)} pips est.)`,
      event: hit,
    }
  }
  return { blocked: false, reason: null, note: "Clear of high-impact windows" }
}

export function evaluateNewsFilter(opts) {
  // sync version used by trading engine — uses cache
  if (!opts?.isNewsFilterEnabled) {
    return { blocked: false, reason: null, note: "News filter disabled on account" }
  }
  const upcoming = getUpcomingEvents(120)
  const watch = (opts.newsFilters || []).map((x) => String(x).toUpperCase())
  const hit = upcoming.find((e) => {
    const name = String(e.name).toUpperCase()
    if (!watch.length) return true
    return watch.some((w) => name.includes(w))
  })
  if (hit) {
    return {
      blocked: true,
      reason: "news_window",
      note: `High-impact window: ${hit.name}`,
      event: hit,
    }
  }
  return { blocked: false, reason: null, note: "Clear of high-impact windows (cache)" }
}

// seed cache on module load (non-blocking)
refreshNewsCache().catch(() => {})
