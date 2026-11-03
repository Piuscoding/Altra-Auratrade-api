import Trade from "../models/Trade.js"
import BrokerAccount from "../models/BrokerAccount.js"
import MetaApiConnection from "../models/MetaApiConnection.js"
import { decryptSecret } from "../utils/cryptoSecrets.js"
import { getOandaOrder, getOandaAccountSummary } from "./oandaClient.js"
import { getIbkrOrderStatus, getIbkrAccountSummary, recoverIbkrSession } from "./ibkrClient.js"
import { syncBrokerLiveBalance } from "./brokerExecutionService.js"
import { writeAudit } from "./auditService.js"

/**
 * Map broker order state → trade status + metadata
 */
export function mapOrderStatusToTrade(orderStatus) {
  switch (orderStatus) {
    case "filled":
      return { status: "open", fillState: "filled" }
    case "partial":
      return { status: "open", fillState: "partial" }
    case "submitted":
    case "pending":
      return { status: "pending", fillState: orderStatus }
    case "cancelled":
      return { status: "cancelled", fillState: "cancelled" }
    case "rejected":
      return { status: "rejected", fillState: "rejected" }
    default:
      return { status: null, fillState: orderStatus || "unknown" }
  }
}

export async function syncTradeOrderStatus(userId, tradeId) {
  const trade = await Trade.findOne({ _id: tradeId, userId })
  if (!trade) {
    return { ok: false, error: "Trade not found" }
  }
  if (!trade.brokerAccountId) {
    return { ok: false, error: "Trade has no broker account" }
  }

  const account = await BrokerAccount.findOne({ _id: trade.brokerAccountId, userId })
  if (!account) return { ok: false, error: "Broker account not found" }

  const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
  const orderId =
    trade.metadata?.externalOrderId ||
    trade.metadata?.oandaOrderId ||
    trade.metadata?.ibkrOrderId ||
    trade.metadata?.metaApiOrderId

  if (!orderId) {
    return { ok: false, error: "No external order id on this trade yet" }
  }

  let result = { ok: false, error: "Provider not supported for status sync" }

  if (account.provider === "oanda") {
    const accountId = conn?.login || conn?.metaApiAccountId
    const token = decryptSecret(conn?.passwordEnc)
    result = await getOandaOrder(accountId, token, orderId)
  } else if (account.provider === "ibkr") {
    const accountId = conn?.metaApiAccountId || process.env.IBKR_ACCOUNT_ID
    const token = decryptSecret(conn?.passwordEnc)
    result = await getIbkrOrderStatus(accountId, token, orderId)
  } else if (account.provider === "metaapi") {
    // MetaApi often fills immediately; mark from metadata if present
    result = {
      ok: true,
      orderStatus: trade.status === "open" ? "filled" : trade.status === "pending" ? "pending" : trade.status,
      orderId,
    }
  }

  if (!result.ok) {
    return { ok: false, error: result.error || "Status sync failed", provider: account.provider }
  }

  const mapped = mapOrderStatusToTrade(result.orderStatus)
  if (mapped.status && trade.status !== "closed") {
    if (mapped.status === "open" || mapped.status === "pending") {
      trade.status = mapped.status
    } else if (mapped.status === "rejected" || mapped.status === "cancelled") {
      trade.status = mapped.status
      trade.rejectReason = trade.rejectReason || `Broker ${mapped.fillState}`
    }
  }

  trade.metadata = {
    ...(trade.metadata || {}),
    fillState: mapped.fillState,
    lastBrokerStatus: result.orderStatus || result.state,
    lastStatusSyncAt: new Date().toISOString(),
    avgPrice: result.avgPrice ?? result.price ?? trade.metadata?.avgPrice,
    filledQuantity: result.filledQuantity ?? result.filledUnits ?? trade.metadata?.filledQuantity,
  }
  if (result.fillPrice != null) trade.entryPrice = result.fillPrice
  if (result.avgPrice != null) trade.entryPrice = result.avgPrice
  await trade.save()

  return {
    ok: true,
    trade,
    orderStatus: result.orderStatus,
    fillState: mapped.fillState,
    provider: account.provider,
  }
}

export async function syncAccountLiveState(userId, brokerAccountId) {
  const account = await BrokerAccount.findOne({ _id: brokerAccountId, userId })
  if (!account) return { ok: false, error: "Broker account not found" }

  // IBKR: try session recovery first
  if (account.provider === "ibkr") {
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const token = decryptSecret(conn?.passwordEnc)
    const recovery = await recoverIbkrSession(token)
    if (!recovery.ok) {
      account.lastError = recovery.error
      await account.save()
      return {
        ok: false,
        provider: "ibkr",
        error: recovery.error,
        session: recovery,
      }
    }
  }

  const bal = await syncBrokerLiveBalance(account)
  if (!bal.ok) {
    account.lastError = bal.error
    await account.save()
    return { ok: false, provider: account.provider, error: bal.error }
  }

  if (bal.balance != null) account.balance = bal.balance
  if (bal.equity != null) account.equity = bal.equity
  if (bal.currency) account.currency = bal.currency
  account.lastError = null
  account.lastSyncAt = new Date()
  if (account.status === "error") account.status = "connected"
  await account.save()

  try {
    await writeAudit({
      userId,
      action: "broker.sync",
      resource: "BrokerAccount",
      resourceId: account._id,
      summary: `Synced ${account.provider} balance ${bal.balance}`,
      meta: { equity: bal.equity },
    })
  } catch {
    /* */
  }

  return {
    ok: true,
    account,
    balance: bal.balance,
    equity: bal.equity,
    currency: bal.currency,
    provider: account.provider,
  }
}

export async function syncOpenTradesForAccount(userId, brokerAccountId) {
  const trades = await Trade.find({
    userId,
    brokerAccountId,
    status: { $in: ["pending", "open"] },
  }).limit(50)

  const results = []
  for (const t of trades) {
    try {
      const r = await syncTradeOrderStatus(userId, t._id)
      results.push({ tradeId: t._id, ...r })
    } catch (err) {
      results.push({ tradeId: t._id, ok: false, error: err.message })
    }
  }
  return { ok: true, count: results.length, results }
}
