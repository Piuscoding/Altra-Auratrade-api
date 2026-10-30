import AccountConfig from "../models/AccountConfig.js"
import Trade from "../models/Trade.js"

const SESSION_WINDOWS = {
  sydney: { start: 21, end: 6 },
  tokyo: { start: 0, end: 9 },
  london: { start: 7, end: 16 },
  newyork: { start: 12, end: 21 },
}

export function getCurrentForexSession(date = new Date()) {
  const utcHour = date.getUTCHours()
  const active = []
  for (const [name, w] of Object.entries(SESSION_WINDOWS)) {
    if (w.start < w.end) {
      if (utcHour >= w.start && utcHour < w.end) active.push(name)
    } else if (utcHour >= w.start || utcHour < w.end) {
      active.push(name)
    }
  }
  return active
}

function dayKey(date = new Date()) {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
  return days[date.getUTCDay()]
}

function startOfUtcWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diff)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export async function getOrCreateAccountConfig(userId, strategyId) {
  let config = await AccountConfig.findOne({ userId, strategyId })
  if (!config) {
    config = await AccountConfig.create({
      userId,
      strategyId,
      type: "demo",
      sessions: ["london", "newyork", "tokyo", "sydney"],
      tradeFrequency: {
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: false,
        sunday: false,
      },
      maxTradesPerWeek: null,
      oneSignalPerSession: true,
      allowMultipleSessions: true,
      tradeDirection: "long_short",
      allowedPairs: [],
      onlySignals: false,
      propFirmLimits: {
        maxDailyDD: 5,
        maxWeeklyDD: 10,
        maxOpenRisk: 2,
        maxConsecutiveLosses: 3,
        dailyLossCap: 3,
        weeklyLossCap: 6,
      },
    })
  }
  return config
}

export async function evaluateSignal(signal, { userId, strategyId }) {
  const config = await getOrCreateAccountConfig(userId, strategyId)
  const now = new Date()
  const checks = {
    session: true,
    day: true,
    maxTrades: true,
    onePerSession: true,
    direction: true,
    pairs: true,
    onlySignals: config.onlySignals,
    currentSessions: getCurrentForexSession(now),
    reasons: [],
  }

  const allowedSessions = (config.sessions || []).map((s) => s.toLowerCase())
  const active = checks.currentSessions
  const sessionMatch = active.some((s) => allowedSessions.includes(s))
  if (!sessionMatch) {
    checks.session = false
    checks.reasons.push(`Outside allowed sessions (active: ${active.join(", ") || "none"})`)
  }

  const day = dayKey(now)
  if (config.tradeFrequency && config.tradeFrequency[day] === false) {
    checks.day = false
    checks.reasons.push(`Trading disabled on ${day}`)
  }

  if (config.maxTradesPerWeek != null) {
    const weekStart = startOfUtcWeek(now)
    const count = await Trade.countDocuments({
      userId,
      strategyId,
      createdAt: { $gte: weekStart },
      status: { $in: ["open", "closed", "pending", "signal_only"] },
    })
    if (count >= config.maxTradesPerWeek) {
      checks.maxTrades = false
      checks.reasons.push(`Max trades per week reached (${config.maxTradesPerWeek})`)
    }
  }

  if (config.oneSignalPerSession) {
    const primarySession = active[0] || null
    if (primarySession) {
      const openInSession = await Trade.findOne({
        userId,
        strategyId,
        pair: signal.pair,
        session: primarySession,
        status: { $in: ["open", "pending", "signal_only"] },
        createdAt: { $gte: new Date(Date.now() - 8 * 60 * 60 * 1000) },
      })
      if (openInSession) {
        checks.onePerSession = false
        checks.reasons.push(`One signal per session already active for ${signal.pair}`)
      }
    }
  }

  if (config.tradeDirection !== "long_short" && signal.direction !== config.tradeDirection) {
    checks.direction = false
    checks.reasons.push(`Direction ${signal.direction} not allowed (config: ${config.tradeDirection})`)
  }

  if (config.allowedPairs?.length && !config.allowedPairs.includes(signal.pair)) {
    checks.pairs = false
    checks.reasons.push(`Pair ${signal.pair} not in allowed list`)
  }

  const passed =
    checks.session &&
    checks.day &&
    checks.maxTrades &&
    checks.onePerSession &&
    checks.direction &&
    checks.pairs

  return {
    passed,
    config,
    checks,
    session: active[0] || null,
    accountType: config.type,
    onlySignals: config.onlySignals,
    propFirmLimits: config.propFirmLimits,
  }
}
