/**
 * Forex market: open Sunday 22:00 UTC → Friday 22:00 UTC (approx).
 * Sessions in UTC hours (standard, not DST-adjusted for simplicity of production default).
 */
export const SESSIONS = [
  { name: "Sydney", open: 21, close: 6 },
  { name: "Tokyo", open: 0, close: 9 },
  { name: "London", open: 7, close: 16 },
  { name: "New York", open: 12, close: 21 },
]

export function isForexMarketOpen(date = new Date()) {
  const d = new Date(date)
  const day = d.getUTCDay() // 0 Sun ... 6 Sat
  const hour = d.getUTCHours()
  const minute = d.getUTCMinutes()
  const mins = hour * 60 + minute

  // Saturday always closed
  if (day === 6) return false
  // Sunday: opens 22:00 UTC
  if (day === 0) return mins >= 22 * 60
  // Friday: closes 22:00 UTC
  if (day === 5) return mins < 22 * 60
  // Mon–Thu open
  return true
}

export function getActiveSessions(date = new Date()) {
  if (!isForexMarketOpen(date)) return []
  const utcHour = date.getUTCHours()
  return SESSIONS.filter((s) => {
    if (s.open < s.close) return utcHour >= s.open && utcHour < s.close
    return utcHour >= s.open || utcHour < s.close
  }).map((s) => s.name)
}

export function getMarketStatus(date = new Date()) {
  const open = isForexMarketOpen(date)
  const sessions = getActiveSessions(date)
  return {
    isOpen: open,
    label: open ? "Market Open" : "Market Closed",
    sessions,
    sessionLabel: open
      ? sessions.length
        ? sessions.join(" + ")
        : "Off-peak"
      : "Weekend / closed",
  }
}
