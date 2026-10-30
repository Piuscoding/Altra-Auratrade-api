/**
 * News filter engine — blocks signals around high-impact events.
 * Uses user-defined lists + built-in high-impact event names.
 * Cron-ready: checkNewsWindow can be called every 5 minutes.
 */

const BUILTIN_HIGH_IMPACT = [
  "FOMC",
  "CPI",
  "PPI",
  "NFP",
  "NonFarmPayrolls",
  "Non-Farm Payrolls",
  "GDP",
  "Unemployment Claims",
  "ECB",
  "BOE",
  "RBA",
  "BOJ",
]

/** In-memory demo calendar entries: { name, time: ISO, impact: high|medium } */
const DEMO_CALENDAR = []

export function seedDemoNewsEvent({ name, minutesFromNow = 30, impact = "high" }) {
  const time = new Date(Date.now() + minutesFromNow * 60 * 1000)
  DEMO_CALENDAR.push({ name, time, impact })
  return { name, time, impact }
}

export function clearDemoNewsEvents() {
  DEMO_CALENDAR.length = 0
}

export function getUpcomingEvents(withinMinutes = 120) {
  const now = Date.now()
  const end = now + withinMinutes * 60 * 1000
  return DEMO_CALENDAR.filter((e) => {
    const t = new Date(e.time).getTime()
    return t >= now - 15 * 60 * 1000 && t <= end
  })
}

/**
 * @param {object} opts
 * @param {boolean} opts.isNewsFilterEnabled
 * @param {string[]} opts.newsFilters
 * @param {string[]} opts.newsFilterCustom
 * @param {number} opts.blockWindowMinutes - minutes before/after event to block
 */
export function evaluateNewsFilter({
  isNewsFilterEnabled = true,
  newsFilters = [],
  newsFilterCustom = [],
  blockWindowMinutes = 30,
} = {}) {
  if (!isNewsFilterEnabled) {
    return {
      blocked: false,
      reason: null,
      event: null,
      note: "News filter disabled by user",
    }
  }

  const watched = [
    ...BUILTIN_HIGH_IMPACT,
    ...(newsFilters || []),
    ...(newsFilterCustom || []),
  ].map((s) => String(s).toLowerCase())

  const now = Date.now()
  const windowMs = blockWindowMinutes * 60 * 1000

  for (const ev of DEMO_CALENDAR) {
    if (ev.impact !== "high") continue
    const t = new Date(ev.time).getTime()
    if (Math.abs(t - now) > windowMs) continue
    const nameLower = String(ev.name).toLowerCase()
    const match =
      watched.some((w) => nameLower.includes(w) || w.includes(nameLower)) ||
      BUILTIN_HIGH_IMPACT.some((b) => nameLower.includes(b.toLowerCase()))
    if (match) {
      return {
        blocked: true,
        reason: `skipped_due_to_news`,
        event: ev.name,
        eventTime: ev.time,
        note: `High-impact event ${ev.name} within ±${blockWindowMinutes}m window`,
      }
    }
  }

  return { blocked: false, reason: null, event: null, note: "Clear" }
}

export function estimateNewsImpactPips(pair, eventName) {
  const base = 20
  const volatile = ["XAUUSD", "GBPJPY", "EURUSD", "GBPUSD"]
  const mult = volatile.some((p) => pair?.toUpperCase().includes(p.slice(0, 3))) ? 1.5 : 1
  if (/FOMC|NFP|CPI/i.test(eventName || "")) return Math.round(base * mult * 1.4)
  return Math.round(base * mult)
}
