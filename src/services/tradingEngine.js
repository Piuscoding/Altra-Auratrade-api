import crypto from "crypto"
import Strategy from "../models/Strategy.js"
import Signal from "../models/Signal.js"
import Trade from "../models/Trade.js"
import BrokerAccount from "../models/BrokerAccount.js"
import redis from "../config/redis.js"
import { evaluateSignal as evaluateSession } from "./sessionAccountEngine.js"
import { evaluateNewsFilter } from "./newsFilterEngine.js"
import { evaluateRisk } from "./riskEngine.js"
import { processPosition } from "./riskAdjustmentEngine.js"
import MetaApiConnection from "../models/MetaApiConnection.js"
import { isMetaApiConfigured } from "./metaApiClient.js"
import { executeLiveOpen, executeLiveClose } from "./brokerExecution.js"
import { recomputeDemoMetrics } from "./strategyMetricsService.js"
import { evaluatePropFirmGates, applyTradeToPropChallenge } from "./propFirmEngine.js"
import { validateBeforeSignal } from "./preSignalValidation.js"
import { notifyUser } from "./notificationService.js"
import { writeAudit } from "./auditService.js"

function cacheKey(userId, strategyId, pair, direction) {
  return `signal:${userId}:${strategyId}:${pair}:${direction}`
}

/**
 * Full pipeline: generate → news → session → risk → paper execute or signal_only
 */
export async function processIncomingSignal(userId, payload) {
  const {
    strategyId,
    pair,
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    timeframe = "M15",
    confidence = 0,
  } = payload

  if (!strategyId || !pair || !direction) {
    throw Object.assign(new Error("strategyId, pair, and direction are required"), { status: 400 })
  }
  if (!["long", "short"].includes(direction)) {
    throw Object.assign(new Error("direction must be long or short"), { status: 400 })
  }

  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    throw Object.assign(new Error("Strategy not found"), { status: 404 })
  }
  if (!["approved", "demo", "live"].includes(strategy.status)) {
    throw Object.assign(
      new Error("Strategy must be approved, demo, or live to generate signals"),
      { status: 400 }
    )
  }

  const ck = cacheKey(userId, strategyId, pair.toUpperCase(), direction)
  try {
    const cached = await redis.get(ck)
    if (cached) {
      return { ...JSON.parse(cached), cached: true }
    }
  } catch {
    /* redis optional */
  }

  let signal = await Signal.create({
    userId,
    strategyId,
    pair: pair.toUpperCase(),
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    timeframe,
    confidence: confidence || strategy.overallConfidence || 0,
    status: "generated",
  })


  // 0) Pre-signal validation (quick backtest + metric gates)
  const pre = await validateBeforeSignal(userId, {
    strategyId,
    pair: signal.pair,
  })
  if (pre.blocked) {
    signal.status = "rejected"
    signal.rejectReason = pre.note
    signal.riskChecks = { ...(signal.riskChecks || {}), preSignal: pre }
    await signal.save()
    const trade = await Trade.create({
      userId,
      strategyId,
      pair: signal.pair,
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      status: "rejected",
      rejectReason: pre.note,
      signalId: String(signal._id),
      executionMethod: "paper",
    })
    await notifyUser(userId, {
      type: "signal",
      title: "Signal blocked — pre-validation",
      body: pre.note,
      severity: "warning",
      meta: { signalId: signal._id, stage: "pre_signal", failures: pre.failures },
    })
    return { signal, trade, accepted: false, stage: "pre_signal", preSignal: pre }
  }
  if (!pre.ok && pre.mode === "warn") {
    signal.riskChecks = { ...(signal.riskChecks || {}), preSignal: pre }
  }

  // 1) News filter (before session) — uses strategy-linked broker news prefs if any
  const broker = await BrokerAccount.findOne({
    userId,
    assignedStrategy: strategyId,
    status: { $in: ["connected", "live", "testing"] },
  })
  const newsResult = evaluateNewsFilter({
    isNewsFilterEnabled: broker?.isNewsFilterEnabled !== false,
    newsFilters: broker?.newsFilters || ["FOMC", "CPI", "NFP"],
    newsFilterCustom: broker?.newsFilterCustom || [],
    blockWindowMinutes: 30,
  })
  signal.newsChecks = newsResult

  if (newsResult.blocked) {
    signal.status = "rejected"
    signal.rejectReason = newsResult.note
    await signal.save()
    const trade = await Trade.create({
      userId,
      strategyId,
      pair: signal.pair,
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      status: "skipped_due_to_news",
      skippedDueToNews: true,
      newsEvent: newsResult.event,
      newsEventTime: newsResult.eventTime,
      rejectReason: newsResult.note,
      signalId: String(signal._id),
      executionMethod: "paper",
    })
    await notifyUser(userId, {
      type: "trade_rejected",
      title: "Signal skipped — news filter",
      body: `${signal.pair} ${direction}: ${newsResult.note}`,
      severity: "warning",
      meta: { signalId: signal._id, stage: "news" },
    })
    await writeAudit({
      userId,
      action: "signal.rejected",
      resource: "Signal",
      resourceId: signal._id,
      summary: `News filter blocked ${signal.pair}`,
      details: newsResult,
    })
    const out = { signal, trade, accepted: false, stage: "news" }
    return out
  }

  // 2) Session & account
  const sessionResult = await evaluateSession(signal, { userId, strategyId })
  signal.sessionChecks = sessionResult.checks
  signal.session = sessionResult.session
  signal.onlySignals = sessionResult.onlySignals

  if (!sessionResult.passed) {
    signal.status = "rejected"
    signal.rejectReason = sessionResult.checks.reasons.join("; ")
    await signal.save()
    const trade = await Trade.create({
      userId,
      strategyId,
      pair: signal.pair,
      direction,
      status: "skipped_session",
      session: sessionResult.session,
      accountType: sessionResult.accountType,
      rejectReason: signal.rejectReason,
      signalId: String(signal._id),
      executionMethod: "paper",
    })
    await notifyUser(userId, {
      type: "trade_rejected",
      title: "Signal skipped — session rules",
      body: `${signal.pair} ${direction}: ${signal.rejectReason}`,
      severity: "warning",
      meta: { signalId: signal._id, stage: "session" },
    })
    return { signal, trade, accepted: false, stage: "session" }
  }

  // 3) Risk
  const balance = broker?.balance || 10000
  const riskResult = await evaluateRisk(signal, {
    userId,
    accountBalance: balance,
    propFirmLimits:
      sessionResult.accountType === "prop_firm" ? sessionResult.propFirmLimits : null,
  })
  signal.riskChecks = riskResult

  if (!riskResult.passed) {
    signal.status = "rejected"
    signal.rejectReason = riskResult.reasons.join("; ")
    await signal.save()
    const trade = await Trade.create({
      userId,
      strategyId,
      pair: signal.pair,
      direction,
      status: "skipped_risk",
      session: sessionResult.session,
      accountType: sessionResult.accountType,
      rejectReason: signal.rejectReason,
      signalId: String(signal._id),
      riskPercent: riskResult.riskPercent,
      executionMethod: "paper",
    })
    await notifyUser(userId, {
      type: "trade_rejected",
      title: "Signal skipped — risk limits",
      body: `${signal.pair} ${direction}: ${signal.rejectReason}`,
      severity: "critical",
      meta: { signalId: signal._id, stage: "risk" },
    })
    return { signal, trade, accepted: false, stage: "risk" }
  }

  // 4) Accept — signal_only or paper pending (broker execution in Phase 6)

  // 3b) Prop firm challenge gates (when active challenge on account)
  try {
    const brokerForProp = await BrokerAccount.findOne({
      userId,
      assignedStrategy: strategyId,
      status: { $in: ["connected", "live", "testing"] },
    })
    const propResult = await evaluatePropFirmGates({
      userId,
      brokerAccountId: brokerForProp?._id || broker?._id,
      riskPercent: riskResult.riskPercent || 1,
    })
    if (propResult.blocked) {
      signal.status = "rejected"
      signal.rejectReason = propResult.note
      await signal.save()
      const trade = await Trade.create({
        userId,
        strategyId,
        brokerAccountId: brokerForProp?._id || broker?._id || null,
        signalId: String(signal._id),
        pair: signal.pair,
        direction,
        entryPrice,
        stopLoss,
        takeProfit,
        status: "rejected",
        rejectReason: propResult.note,
        accountType: "prop_firm",
        propLimitsApplied: true,
        executionMethod: "paper",
      })
      await notifyUser(userId, {
        type: "signal",
        title: "Signal blocked — prop firm",
        body: propResult.note,
        severity: "warning",
        meta: { signalId: signal._id, stage: "prop_firm" },
      })
      return { signal, trade, accepted: false, stage: "prop_firm", prop: propResult }
    }
  } catch (propErr) {
    console.warn("[prop] gate:", propErr.message)
  }

  // Persist chart markup for replay on Charts workspace
  const entryN = Number(entryPrice)
  const slN = Number(stopLoss)
  const tpN = Number(takeProfit)
  let rrMark = null
  if (Number.isFinite(entryN) && Number.isFinite(slN) && Number.isFinite(tpN) && entryN !== slN) {
    rrMark = Number((Math.abs(tpN - entryN) / Math.abs(entryN - slN)).toFixed(2))
  }
  signal.chartMarkup = {
    entry: entryPrice,
    stopLoss,
    takeProfit,
    direction,
    pair: signal.pair,
    strategyName: strategy.name,
    plottedLevels: strategy.plottedLevels || {},
    rules: strategy.rules || {},
    rr: rrMark,
    source: payload.metadata?.auto ? "auto_signal" : "manual_signal",
  }

  const onlySignals = sessionResult.onlySignals
  signal.status = onlySignals ? "signal_only" : "validated"
  await signal.save()

  const trade = await Trade.create({
    userId,
    strategyId,
    brokerAccountId: broker?._id || null,
    signalId: String(signal._id),
    pair: signal.pair,
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    originalSL: stopLoss,
    riskPercent: riskResult.riskPercent,
    status: onlySignals ? "signal_only" : "pending",
    session: sessionResult.session,
    accountType: sessionResult.accountType,
    propLimitsApplied: sessionResult.accountType === "prop_firm",
    provider: broker?.provider || null,
    executionMethod: broker
      ? broker.provider === "metaapi"
        ? "metaapi"
        : broker.provider === "oanda" || broker.provider === "ibkr"
          ? "direct_api"
          : "paper"
      : "paper",
  })
  signal.tradeId = trade._id
  signal.status = onlySignals ? "signal_only" : "executed"
  await signal.save()

  // Auto-open live market order when MetaApi is configured and account is live-connected
  let executionNote = onlySignals ? "signal only" : "pending execution"
  if (
    !onlySignals &&
    broker &&
    ["connected", "live", "testing"].includes(broker.status) &&
    ["metaapi", "oanda", "ibkr"].includes(broker.provider)
  ) {
    try {
      const opened = await openTrade(userId, trade._id)
      trade.status = opened.status
      trade.metadata = opened.metadata
      executionNote = opened.metadata?.live ? "live MetaApi order" : "opened"
    } catch (execErr) {
      executionNote = `pending (live failed: ${execErr.message})`
    }
  }


  await notifyUser(userId, {
    type: onlySignals ? "signal" : "trade_open",
    title: onlySignals ? "Signal generated" : "Trade accepted",
    body: `${signal.pair} ${direction} · ${executionNote} · session ${sessionResult.session || "n/a"}`,
    severity: "success",
    meta: { signalId: signal._id, tradeId: trade._id },
  })
  await writeAudit({
    userId,
    action: onlySignals ? "signal.created" : "trade.pending",
    resource: "Trade",
    resourceId: trade._id,
    summary: `${signal.pair} ${direction} accepted`,
    details: { onlySignals, session: sessionResult.session },
  })

  const out = {
    signal,
    trade,
    accepted: true,
    stage: onlySignals ? "signal_only" : "accepted",
    risk: riskResult,
    session: sessionResult,
    cached: false,
  }

  try {
    await redis.setex(ck, 60, JSON.stringify({ ...out, signal: signal.toObject(), trade: trade.toObject() }))
  } catch {
    /* optional */
  }

  return out
}

export async function listSignals(userId, { limit = 50 } = {}) {
  return Signal.find({ userId }).sort({ createdAt: -1 }).limit(limit)
}

export async function listTrades(userId, {
  status,
  strategyId,
  accountType,
  outcome,
  from,
  to,
  limit = 500,
} = {}) {
  const q = { userId }
  if (status) q.status = status
  if (strategyId) q.strategyId = strategyId
  if (accountType) q.accountType = accountType
  if (outcome) q.outcome = outcome
  if (from || to) {
    q.createdAt = {}
    if (from) q.createdAt.$gte = new Date(from)
    if (to) {
      const end = new Date(to)
      end.setHours(23, 59, 59, 999)
      q.createdAt.$lte = end
    }
  }
  return Trade.find(q).sort({ createdAt: -1 }).limit(Math.min(1000, Number(limit) || 500))
}

export async function openTrade(userId, tradeId) {
  const trade = await Trade.findOne({ _id: tradeId, userId })
  if (!trade) throw Object.assign(new Error("Trade not found"), { status: 404 })
  if (trade.status !== "pending") {
    throw Object.assign(new Error("Only pending trades can be opened"), { status: 400 })
  }

  let liveResult = null
  if (trade.brokerAccountId) {
    const account = await BrokerAccount.findById(trade.brokerAccountId)
    if (account && ["connected", "live", "testing"].includes(account.status)) {
      liveResult = await executeLiveOpen(trade, account)
      if (liveResult.ok) {
        trade.executionMethod =
          account.provider === "metaapi"
            ? "metaapi"
            : account.provider === "oanda"
              ? "direct_api"
              : account.provider === "ibkr"
                ? "direct_api"
                : trade.executionMethod
        trade.provider = account.provider
        trade.metadata = {
          ...(trade.metadata || {}),
          live: true,
          provider: account.provider,
          externalOrderId:
            liveResult.externalOrderId || liveResult.orderId || liveResult.tradeId || null,
          externalTradeId: liveResult.tradeId || liveResult.externalTradeId || null,
          oandaOrderId: account.provider === "oanda" ? liveResult.orderId || null : undefined,
          oandaTradeId: account.provider === "oanda" ? liveResult.tradeId || null : undefined,
          ibkrOrderId: account.provider === "ibkr" ? liveResult.orderId || null : undefined,
          metaApiOrderId:
            account.provider === "metaapi"
              ? liveResult.externalOrderId || liveResult.orderId || null
              : undefined,
          fillState: liveResult.orderStatus || "submitted",
          fillPrice: liveResult.fillPrice ?? null,
        }
        if (liveResult.fillPrice != null) trade.entryPrice = liveResult.fillPrice
        if (liveResult.orderStatus === "rejected") {
          trade.status = "rejected"
          trade.rejectReason = liveResult.error || "Broker rejected order"
          await trade.save()
          throw Object.assign(new Error(trade.rejectReason), { status: 502 })
        }
        if (liveResult.orderStatus === "pending" || liveResult.orderStatus === "submitted") {
          trade.status = "pending"
        }
      } else if (!liveResult.offline) {
        trade.rejectReason = liveResult.error || "Live order failed"
        trade.metadata = {
          ...(trade.metadata || {}),
          liveError: liveResult.error,
          fillState: "rejected",
        }
        await trade.save()
        throw Object.assign(new Error(liveResult.error || "Live order failed"), { status: 502 })
      }
      // offline → paper open continues
    }
  }

  if (trade.status !== "rejected" && trade.status !== "pending") {
    trade.status = "open"
  }
  await trade.save()
  const providerLabel = liveResult?.ok
    ? `Live (${liveResult.provider || trade.provider || "broker"})`
    : "Paper"
  await notifyUser(userId, {
    type: "trade_open",
    title: `Trade opened — ${providerLabel}`,
    body: `${trade.pair} ${trade.direction} is now open`,
    severity: "success",
    meta: { tradeId: trade._id },
  })
  return trade
}

export async function closeTrade(userId, tradeId, { pnl = 0 } = {}) {
  const trade = await Trade.findOne({ _id: tradeId, userId })
  if (!trade) throw Object.assign(new Error("Trade not found"), { status: 404 })
  if (!["open", "pending", "signal_only"].includes(trade.status)) {
    throw Object.assign(new Error("Trade cannot be closed"), { status: 400 })
  }

  if (trade.status === "open" && trade.brokerAccountId) {
    const account = await BrokerAccount.findById(trade.brokerAccountId)
    if (account) {
      const closed = await executeLiveClose(trade, account)
      trade.metadata = { ...(trade.metadata || {}), closeResult: closed }
      if (closed && !closed.ok && !closed.offline) {
        trade.rejectReason = (trade.rejectReason || "") + ` close_warn:${closed.error}`
      }
    }
  }

  trade.status = "closed"
  trade.pnl = pnl
  trade.closedAt = new Date()
  if (pnl > 0) trade.outcome = "win"
  else if (pnl < 0) trade.outcome = "loss"
  else trade.outcome = "breakeven"
  await trade.save()
  try {
    await recomputeDemoMetrics(trade.strategyId)
  } catch (e) {
    console.warn("[metrics] demo recompute:", e.message)
  }
  try {
    await applyTradeToPropChallenge(trade)
  } catch (e) {
    console.warn("[prop] apply trade:", e.message)
  }
  await notifyUser(userId, {
    type: "trade_close",
    title: "Trade closed",
    body: `${trade.pair} ${trade.direction} closed · PnL ${pnl}`,
    severity: pnl >= 0 ? "success" : "warning",
    meta: { tradeId: trade._id, pnl },
  })
  return trade
}

export async function killAll(userId) {
  const result = await Trade.updateMany(
    { userId, status: { $in: ["open", "pending"] } },
    { $set: { status: "cancelled", closedAt: new Date(), rejectReason: "kill_switch" } }
  )
  await notifyUser(userId, {
    type: "system",
    title: "Kill switch activated",
    body: `Cancelled ${result.modifiedCount} open/pending trade(s).`,
    severity: "critical",
  })
  await writeAudit({
    userId,
    action: "trade.kill_switch",
    resource: "Trade",
    summary: `Kill switch cancelled ${result.modifiedCount} trades`,
  })
  return { cancelled: result.modifiedCount }
}

export async function runRiskAdjustment(userId, tradeId) {
  const trade = await Trade.findOne({ _id: tradeId, userId })
  if (!trade) throw Object.assign(new Error("Trade not found"), { status: 404 })
  const strategy = await Strategy.findById(trade.strategyId)
  if (!strategy) throw Object.assign(new Error("Strategy not found"), { status: 404 })
  return processPosition(trade, strategy, { newsFilterEnabled: false })
}

export async function updateMarkPrice(userId, tradeId, markPrice) {
  const trade = await Trade.findOne({ _id: tradeId, userId })
  if (!trade) throw Object.assign(new Error("Trade not found"), { status: 404 })
  trade.metadata = { ...(trade.metadata || {}), markPrice }
  await trade.save()
  return trade
}
