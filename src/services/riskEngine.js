import Trade from "../models/Trade.js"

const DEFAULT_RISK = {
  riskPerTradePercent: 1,
  maxDailyLossPercent: 3,
  maxWeeklyLossPercent: 6,
  maxOpenRiskPercent: 3,
  maxOpenTrades: 5,
  circuitBreakerDailyLoss: 5,
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function startOfUtcWeek(date = new Date()) {
  const d = startOfUtcDay(date)
  const day = d.getUTCDay()
  const diff = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diff)
  return d
}

export async function evaluateRisk(signal, {
  userId,
  accountBalance = 10000,
  propFirmLimits = null,
  riskConfig = {},
} = {}) {
  const cfg = { ...DEFAULT_RISK, ...riskConfig }
  const reasons = []
  const checks = {
    perTrade: true,
    dailyLoss: true,
    weeklyLoss: true,
    openRisk: true,
    openCount: true,
    circuitBreaker: true,
    prop: true,
  }

  const riskPct = cfg.riskPerTradePercent
  if (riskPct <= 0 || riskPct > 5) {
    checks.perTrade = false
    reasons.push("Risk per trade must be between 0 and 5%")
  }

  const dayStart = startOfUtcDay()
  const weekStart = startOfUtcWeek()

  const closedToday = await Trade.find({
    userId,
    status: "closed",
    closedAt: { $gte: dayStart },
  })
  const dailyPnl = closedToday.reduce((s, t) => s + (t.pnl || 0), 0)
  const dailyLossPct = accountBalance > 0 ? (-Math.min(0, dailyPnl) / accountBalance) * 100 : 0
  if (dailyLossPct >= cfg.maxDailyLossPercent) {
    checks.dailyLoss = false
    reasons.push(`Daily loss cap hit (${dailyLossPct.toFixed(2)}% ≥ ${cfg.maxDailyLossPercent}%)`)
  }
  if (dailyLossPct >= cfg.circuitBreakerDailyLoss) {
    checks.circuitBreaker = false
    reasons.push("Circuit breaker: daily loss exceeds hard limit")
  }

  const closedWeek = await Trade.find({
    userId,
    status: "closed",
    closedAt: { $gte: weekStart },
  })
  const weeklyPnl = closedWeek.reduce((s, t) => s + (t.pnl || 0), 0)
  const weeklyLossPct = accountBalance > 0 ? (-Math.min(0, weeklyPnl) / accountBalance) * 100 : 0
  if (weeklyLossPct >= cfg.maxWeeklyLossPercent) {
    checks.weeklyLoss = false
    reasons.push(`Weekly loss cap hit (${weeklyLossPct.toFixed(2)}%)`)
  }

  const openTrades = await Trade.find({
    userId,
    status: { $in: ["open", "pending"] },
  })
  if (openTrades.length >= cfg.maxOpenTrades) {
    checks.openCount = false
    reasons.push(`Max open trades (${cfg.maxOpenTrades}) reached`)
  }

  const openRiskPct = openTrades.length * riskPct
  if (openRiskPct + riskPct > cfg.maxOpenRiskPercent) {
    checks.openRisk = false
    reasons.push(`Open risk would exceed ${cfg.maxOpenRiskPercent}%`)
  }

  if (propFirmLimits) {
    if (propFirmLimits.maxDailyDD != null && dailyLossPct >= propFirmLimits.maxDailyDD) {
      checks.prop = false
      reasons.push("Prop firm max daily drawdown reached")
    }
    if (propFirmLimits.maxWeeklyDD != null && weeklyLossPct >= propFirmLimits.maxWeeklyDD) {
      checks.prop = false
      reasons.push("Prop firm max weekly drawdown reached")
    }
    if (propFirmLimits.maxOpenRisk != null && openRiskPct + riskPct > propFirmLimits.maxOpenRisk) {
      checks.prop = false
      reasons.push("Prop firm max open risk exceeded")
    }
  }

  const passed = Object.values(checks).every(Boolean)
  const riskAmount = (accountBalance * riskPct) / 100

  return {
    passed,
    checks,
    reasons,
    riskPercent: riskPct,
    riskAmount,
    dailyLossPct,
    weeklyLossPct,
    openTrades: openTrades.length,
  }
}
