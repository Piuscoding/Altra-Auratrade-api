import PropChallenge from "../models/PropChallenge.js"
import Trade from "../models/Trade.js"
import BrokerAccount from "../models/BrokerAccount.js"
import { notifyUser } from "./notificationService.js"
import { writeAudit } from "./auditService.js"

function zonedParts(date = new Date(), timeZone = "UTC") {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
    return {
      dayKey: `${parts.year}-${parts.month}-${parts.day}`,
      weekday: parts.weekday,
    }
  } catch {
    return { dayKey: date.toISOString().slice(0, 10), weekday: "" }
  }
}

function weekKeyFromDayKey(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`
}

function rollDayWeek(challenge, equity) {
  const tz = challenge.timezone || "UTC"
  const { dayKey: day } = zonedParts(new Date(), tz)
  const week = weekKeyFromDayKey(day)
  const stats = challenge.stats || {}
  if (stats.dayStartDate !== day) {
    // Close previous trading day stats for consistency
    if (stats.dayStartDate) {
      if ((stats.dailyPnL || 0) > 0) {
        stats.tradingDays = (stats.tradingDays || 0) + 1
        stats.bestDayProfit = Math.max(stats.bestDayProfit || 0, stats.dailyPnL || 0)
      } else if ((stats.tradesToday || 0) > 0) {
        // Count day with trades even if flat/loss for min trading days progress
        stats.tradingDays = (stats.tradingDays || 0) + 1
      }
    }
    stats.dayStartDate = day
    stats.dayStartEquity = equity
    stats.dailyPnL = 0
    stats.tradesToday = 0
    stats.dailyDDPercent = 0
  }
  if (stats.weekStartKey !== week) {
    stats.weekStartKey = week
    stats.weekStartEquity = equity
    stats.weeklyPnL = 0
  }
  challenge.stats = stats
}

function pushEquityPoint(challenge) {
  if (!Array.isArray(challenge.equityCurve)) challenge.equityCurve = []
  challenge.equityCurve.push({
    at: new Date(),
    equity: challenge.currentBalance,
    dailyDDPercent: challenge.stats?.dailyDDPercent || 0,
    overallDDPercent: challenge.stats?.overallDDPercent || 0,
    phase: challenge.phase,
  })
  // Keep last 500 points
  if (challenge.equityCurve.length > 500) {
    challenge.equityCurve = challenge.equityCurve.slice(-500)
  }
}

function markFailed(challenge, reason, metrics = {}) {
  challenge.status = "breached"
  challenge.phase = "failed"
  challenge.breachReason = reason
  challenge.breachedAt = new Date()
  if (!Array.isArray(challenge.failReasons)) challenge.failReasons = []
  challenge.failReasons.push({
    at: new Date(),
    reason,
    phase: challenge.phase,
    metrics,
  })
}

function recomputeDerived(challenge) {
  const start = challenge.startingBalance
  const equity = challenge.currentBalance
  const stats = challenge.stats || {}
  stats.overallPnL = equity - start
  const peak = Math.max(challenge.highWaterMark || start, equity)
  challenge.highWaterMark = peak
  stats.overallDDPercent =
    peak > 0 ? Number((((peak - equity) / peak) * 100).toFixed(2)) : 0
  const dayStart = stats.dayStartEquity ?? start
  stats.dailyDDPercent =
    dayStart > 0
      ? Number((((dayStart - Math.min(equity, dayStart)) / dayStart) * 100).toFixed(2))
      : 0
  const target = (challenge.rules?.profitTargetPercent || 8) / 100
  const targetAmt = start * target
  stats.profitTargetProgressPercent =
    targetAmt > 0
      ? Number(Math.min(100, (Math.max(0, stats.overallPnL) / targetAmt) * 100).toFixed(2))
      : 0
  // Consistency: best day share of total profit (lower is better)
  if (stats.overallPnL > 0 && stats.bestDayProfit > 0) {
    const share = (stats.bestDayProfit / stats.overallPnL) * 100
    const maxShare = challenge.rules?.maxDayProfitSharePercent || 40
    stats.consistencyScore = Number(
      Math.max(0, Math.min(100, 100 - Math.max(0, share - maxShare))).toFixed(2)
    )
  } else {
    stats.consistencyScore = 100
  }
  challenge.stats = stats
}

export async function createChallenge(userId, payload) {
  const account = await BrokerAccount.findOne({
    _id: payload.brokerAccountId,
    userId,
  })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  if (account.type !== "prop_firm") {
    throw Object.assign(new Error("Broker account must be type prop_firm"), { status: 400 })
  }
  const existing = await PropChallenge.findOne({
    brokerAccountId: account._id,
    status: "active",
  })
  if (existing) {
    throw Object.assign(new Error("An active challenge already exists for this account"), {
      status: 400,
    })
  }
  const starting =
    Number(payload.startingBalance) ||
    Number(account.balance) ||
    Number(account.equity) ||
    10000
  const challenge = await PropChallenge.create({
    userId,
    brokerAccountId: account._id,
    strategyId: account.assignedStrategy || payload.strategyId || null,
    name: payload.name || `${account.name} Challenge`,
    firmName: payload.firmName || "",
    phase: payload.phase || "challenge",
    startingBalance: starting,
    currentBalance: starting,
    highWaterMark: starting,
    rules: {
      maxDailyDDPercent: payload.rules?.maxDailyDDPercent ?? account.propFirmLimits?.maxDailyDD ?? 5,
      maxOverallDDPercent:
        payload.rules?.maxOverallDDPercent ?? account.propFirmLimits?.maxWeeklyDD ?? 10,
      profitTargetPercent: payload.rules?.profitTargetPercent ?? 8,
      maxOpenRiskPercent:
        payload.rules?.maxOpenRiskPercent ?? account.propFirmLimits?.maxOpenRisk ?? 2,
      maxConsecutiveLosses:
        payload.rules?.maxConsecutiveLosses ??
        account.propFirmLimits?.maxConsecutiveLosses ??
        3,
      maxTradesPerDay: payload.rules?.maxTradesPerDay ?? 10,
      maxDayProfitSharePercent: payload.rules?.maxDayProfitSharePercent ?? 40,
      minTradingDays: payload.rules?.minTradingDays ?? 5,
    },
    stats: {
      dayStartEquity: starting,
      dayStartDate: utcDayKey(),
      weekStartEquity: starting,
      weekStartKey: utcWeekKey(),
      dailyPnL: 0,
      weeklyPnL: 0,
      overallPnL: 0,
      consecutiveLosses: 0,
      tradesToday: 0,
      tradingDays: 0,
      bestDayProfit: 0,
      consistencyScore: 100,
      profitTargetProgressPercent: 0,
    },
    notes: payload.notes || "",
  })
  await writeAudit({
    userId,
    action: "prop_challenge.create",
    resource: "PropChallenge",
    resourceId: challenge._id,
    summary: `Created prop challenge ${challenge.name}`,
  })
  return challenge
}

export async function listChallenges(userId) {
  return PropChallenge.find({ userId }).sort({ createdAt: -1 })
}

export async function getChallenge(userId, id) {
  const c = await PropChallenge.findOne({ _id: id, userId })
  if (!c) throw Object.assign(new Error("Challenge not found"), { status: 404 })
  return c
}

export async function updateChallenge(userId, id, body) {
  const c = await PropChallenge.findOne({ _id: id, userId })
  if (!c) throw Object.assign(new Error("Challenge not found"), { status: 404 })
  if (body.phase && ["challenge", "verification", "funded", "failed", "passed"].includes(body.phase)) {
    c.phase = body.phase
  }
  if (body.status && ["active", "breached", "completed", "paused"].includes(body.status)) {
    c.status = body.status
  }
  if (body.rules && typeof body.rules === "object") {
    c.rules = { ...c.rules.toObject?.() || c.rules, ...body.rules }
  }
  if (body.name) c.name = body.name
  if (body.firmName != null) c.firmName = body.firmName
  if (body.notes != null) c.notes = body.notes
  if (body.timezone) c.timezone = body.timezone
  if (body.currentBalance != null) {
    c.currentBalance = Number(body.currentBalance)
    recomputeDerived(c)
  }
  await c.save()
  return c
}

/**
 * Evaluate whether a new signal/trade is allowed under active prop challenges
 * for this user + optional broker account.
 */
export async function evaluatePropFirmGates({
  userId,
  brokerAccountId,
  riskPercent = 1,
}) {
  if (!brokerAccountId) return { blocked: false, challenges: [] }

  const challenges = await PropChallenge.find({
    userId,
    brokerAccountId,
    status: "active",
  })
  if (!challenges.length) return { blocked: false, challenges: [] }

  const reasons = []
  for (const c of challenges) {
    rollDayWeek(c, c.currentBalance)
    recomputeDerived(c)

    const rules = c.rules || {}
    const stats = c.stats || {}

    if ((stats.dailyDDPercent || 0) >= (rules.maxDailyDDPercent || 5)) {
      reasons.push(`${c.name}: daily DD ${stats.dailyDDPercent}% ≥ ${rules.maxDailyDDPercent}%`)
      markFailed(c, reasons[reasons.length - 1], { dailyDDPercent: stats.dailyDDPercent })
    }
    if ((stats.overallDDPercent || 0) >= (rules.maxOverallDDPercent || 10)) {
      reasons.push(`${c.name}: overall DD ${stats.overallDDPercent}% ≥ ${rules.maxOverallDDPercent}%`)
      markFailed(c, reasons[reasons.length - 1], { overallDDPercent: stats.overallDDPercent })
    }
    if ((stats.tradesToday || 0) >= (rules.maxTradesPerDay || 10)) {
      reasons.push(`${c.name}: max trades/day reached (${stats.tradesToday})`)
    }
    if ((stats.consecutiveLosses || 0) >= (rules.maxConsecutiveLosses || 3)) {
      reasons.push(`${c.name}: consecutive losses ${stats.consecutiveLosses}`)
    }
    if (riskPercent > (rules.maxOpenRiskPercent || 2)) {
      reasons.push(
        `${c.name}: open risk ${riskPercent}% > max ${rules.maxOpenRiskPercent}%`
      )
    }

    // Consistency soft-check at open: if already over share with profit, block new risk
    if ((stats.overallPnL || 0) > 0 && (stats.bestDayProfit || 0) > 0) {
      const share = (stats.bestDayProfit / stats.overallPnL) * 100
      const maxShare = rules.maxDayProfitSharePercent || 40
      if (share > maxShare && (stats.dailyPnL || 0) > 0) {
        reasons.push(
          `${c.name}: consistency risk — best day ${share.toFixed(1)}% of profit (max ${maxShare}%)`
        )
      }
    }

    await c.save()
  }

  const blocked = reasons.length > 0
  return {
    blocked,
    note: blocked ? reasons.join("; ") : null,
    reasons,
    challenges: challenges.map((c) => c._id),
  }
}

export async function applyTradeToPropChallenge(trade) {
  if (!trade?.brokerAccountId && trade?.accountType !== "prop_firm") return null
  const q = {
    userId: trade.userId,
    status: "active",
  }
  if (trade.brokerAccountId) q.brokerAccountId = trade.brokerAccountId
  const challenge = await PropChallenge.findOne(q)
  if (!challenge) return null

  const pnl = Number(trade.pnl) || 0
  rollDayWeek(challenge, challenge.currentBalance)
  challenge.currentBalance = Number((challenge.currentBalance + pnl).toFixed(2))
  challenge.stats.dailyPnL = Number(((challenge.stats.dailyPnL || 0) + pnl).toFixed(2))
  challenge.stats.weeklyPnL = Number(((challenge.stats.weeklyPnL || 0) + pnl).toFixed(2))
  challenge.stats.tradesToday = (challenge.stats.tradesToday || 0) + 1

  if (pnl < 0) {
    challenge.stats.consecutiveLosses = (challenge.stats.consecutiveLosses || 0) + 1
  } else if (pnl > 0) {
    challenge.stats.consecutiveLosses = 0
  }

  recomputeDerived(challenge)

  // Breach checks
  const r = challenge.rules
  const s = challenge.stats
  let breached = null
  if (s.dailyDDPercent >= r.maxDailyDDPercent) breached = `Daily DD ${s.dailyDDPercent}%`
  else if (s.overallDDPercent >= r.maxOverallDDPercent)
    breached = `Overall DD ${s.overallDDPercent}%`
  else if (s.consecutiveLosses >= r.maxConsecutiveLosses)
    breached = `Consecutive losses ${s.consecutiveLosses}`

  if (breached) {
    challenge.status = "breached"
    challenge.phase = "failed"
    challenge.breachReason = breached
    challenge.breachedAt = new Date()
    await challenge.save()
    await notifyUser(trade.userId, {
      type: "system",
      title: "Prop challenge breached",
      body: `${challenge.name}: ${breached}`,
      severity: "critical",
      meta: { challengeId: challenge._id },
    })
    return challenge
  }

  // Profit target + min days + consistency → passed challenge phase
  // Hard consistency fail: single day profit share exceeds rule after a winning day close
  if (
    challenge.status === "active" &&
    (stats.overallPnL || 0) > 0 &&
    (stats.bestDayProfit || 0) > 0
  ) {
    const share = (stats.bestDayProfit / stats.overallPnL) * 100
    const maxShare = rules.maxDayProfitSharePercent || 40
    if (share > maxShare && stats.overallPnL >= (challenge.startingBalance * ((rules.profitTargetPercent || 8) / 100) * 0.5)) {
      markFailed(
        challenge,
        `Consistency rule: best day is ${share.toFixed(1)}% of total profit (max ${maxShare}%)`,
        { share, maxShare, bestDayProfit: stats.bestDayProfit, overallPnL: stats.overallPnL }
      )
    }
  }

  const targetHit = s.profitTargetProgressPercent >= 100
  const daysOk = (s.tradingDays || 0) >= (r.minTradingDays || 5)
  const consistencyOk =
    s.overallPnL <= 0 ||
    (s.bestDayProfit || 0) / Math.max(s.overallPnL, 1) * 100 <=
      (r.maxDayProfitSharePercent || 40) + 0.01

  if (targetHit && daysOk && consistencyOk && challenge.phase === "challenge") {
    challenge.phase = "verification"
    await notifyUser(trade.userId, {
      type: "system",
      title: "Prop challenge target reached",
      body: `${challenge.name} moved to verification phase`,
      severity: "success",
      meta: { challengeId: challenge._id },
    })
  } else if (targetHit && daysOk && consistencyOk && challenge.phase === "verification") {
    challenge.phase = "funded"
    challenge.status = "completed"
    challenge.completedAt = new Date()
    await notifyUser(trade.userId, {
      type: "system",
      title: "Prop challenge funded",
      body: `${challenge.name} completed — funded phase`,
      severity: "success",
      meta: { challengeId: challenge._id },
    })
  }

  await challenge.save()
  return challenge
}

export async function pauseChallenge(userId, id, reason = "Paused by user") {
  const c = await getChallenge(userId, id)
  if (c.status !== "active") {
    throw Object.assign(new Error(`Cannot pause challenge in status ${c.status}`), { status: 400 })
  }
  c.status = "paused"
  c.pausedAt = new Date()
  c.pauseReason = reason
  await c.save()
  await writeAudit({
    userId,
    action: "prop.pause",
    resource: "PropChallenge",
    resourceId: c._id,
    summary: reason,
  })
  return c
}

export async function resumeChallenge(userId, id) {
  const c = await getChallenge(userId, id)
  if (c.status !== "paused") {
    throw Object.assign(new Error("Only paused challenges can be resumed"), { status: 400 })
  }
  c.status = "active"
  c.resumedAt = new Date()
  c.pauseReason = null
  rollDayWeek(c, c.currentBalance)
  recomputeDerived(c)
  await c.save()
  await writeAudit({
    userId,
    action: "prop.resume",
    resource: "PropChallenge",
    resourceId: c._id,
    summary: "Challenge resumed",
  })
  return c
}

export async function failChallenge(userId, id, reason = "Manually failed") {
  const c = await getChallenge(userId, id)
  if (!["active", "paused"].includes(c.status)) {
    throw Object.assign(new Error(`Cannot fail challenge in status ${c.status}`), { status: 400 })
  }
  markFailed(c, reason, { manual: true })
  await c.save()
  await notifyUser(userId, {
    type: "system",
    title: "Prop challenge failed",
    body: `${c.name}: ${reason}`,
    severity: "error",
    meta: { challengeId: c._id },
  })
  await writeAudit({
    userId,
    action: "prop.fail",
    resource: "PropChallenge",
    resourceId: c._id,
    summary: reason,
  })
  return c
}

export async function refreshChallenge(userId, id) {
  const c = await getChallenge(userId, id)
  rollDayWeek(c, c.currentBalance)
  recomputeDerived(c)
  pushEquityPoint(c)
  await c.save()
  return c
}
