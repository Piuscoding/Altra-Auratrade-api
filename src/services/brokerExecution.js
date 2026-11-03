import MetaApiConnection from "../models/MetaApiConnection.js"
import { decryptSecret } from "../utils/cryptoSecrets.js"
import {
  placeMarketOrder as metaPlace,
  closePosition as metaClose,
  isMetaApiConfigured,
} from "./metaApiClient.js"
import {
  placeOandaMarketOrder,
  closeOandaTrade,
  getOandaAccountSummary,
  toOandaInstrument,
} from "./oandaClient.js"
import {
  placeIbkrMarketOrder,
  closeIbkrPosition,
  getIbkrAccountSummary,
} from "./ibkrClient.js"

/**
 * Unified live execution router by broker provider.
 */

function unitsFromLots(pair, lots = 0.01) {
  // Standard lot 100_000 units for FX; metals approximate
  const p = String(pair).toUpperCase()
  if (p.startsWith("XAU")) return Math.max(1, Math.round(Number(lots) * 100))
  if (p.startsWith("XAG")) return Math.max(1, Math.round(Number(lots) * 5000))
  return Math.max(1, Math.round(Number(lots) * 100000))
}

export async function executeLiveOpen(trade, account) {
  const provider = account?.provider || trade.provider
  const volume = trade.lotSize && trade.lotSize > 0 ? trade.lotSize : 0.01

  if (provider === "metaapi") {
    if (!isMetaApiConfigured()) {
      return { ok: false, offline: true, error: "METAAPI_TOKEN not set" }
    }
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.metaApiAccountId
    if (!accountId || String(accountId).startsWith("local-")) {
      return { ok: false, offline: true, error: "No live MetaApi account id" }
    }
    const result = await metaPlace(accountId, {
      symbol: trade.pair,
      actionType: trade.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      comment: "Altra-AuraTrade",
    })
    return {
      ...result,
      provider: "metaapi",
      externalOrderId: result.orderId,
    }
  }

  if (provider === "oanda") {
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.login || conn?.metaApiAccountId
    const token = decryptSecret(conn?.passwordEnc)
    if (!accountId || !token) {
      return { ok: false, offline: true, error: "OANDA credentials missing" }
    }
    const units =
      trade.direction === "long"
        ? unitsFromLots(trade.pair, volume)
        : -unitsFromLots(trade.pair, volume)
    const result = await placeOandaMarketOrder(accountId, token, {
      instrument: trade.pair,
      units,
      stopLossPrice: trade.stopLoss,
      takeProfitPrice: trade.takeProfit,
      clientExtensions: { comment: "Altra-AuraTrade" },
    })
    return {
      ...result,
      provider: "oanda",
      externalOrderId: result.orderId,
      externalTradeId: result.tradeId,
    }
  }

  if (provider === "ibkr") {
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.login || conn?.metaApiAccountId
    const token = decryptSecret(conn?.passwordEnc) || "gateway"
    if (!accountId) {
      return { ok: false, offline: true, error: "IBKR account id missing" }
    }
    const result = await placeIbkrMarketOrder(accountId, token, {
      symbol: trade.pair,
      fxPair: toOandaInstrument(trade.pair).replace("_", ""),
      side: trade.direction === "long" ? "BUY" : "SELL",
      quantity: unitsFromLots(trade.pair, volume),
    })
    return {
      ...result,
      provider: "ibkr",
      externalOrderId: result.orderId,
    }
  }

  return { ok: false, offline: true, error: `Provider ${provider} has no live adapter` }
}

export async function executeLiveClose(trade, account) {
  const provider = account?.provider || trade.provider

  if (provider === "metaapi") {
    if (!isMetaApiConfigured()) {
      return { ok: false, offline: true, error: "METAAPI_TOKEN not set" }
    }
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.metaApiAccountId
    const positionId = trade.metadata?.metaApiOrderId || trade.metadata?.externalOrderId
    if (!accountId || !positionId || String(accountId).startsWith("local-")) {
      return { ok: false, offline: true, error: "Cannot close MetaApi position" }
    }
    return { ...(await metaClose(accountId, positionId)), provider: "metaapi" }
  }

  if (provider === "oanda") {
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.login || conn?.metaApiAccountId
    const token = decryptSecret(conn?.passwordEnc)
    const tradeId =
      trade.metadata?.externalTradeId ||
      trade.metadata?.oandaTradeId ||
      trade.metadata?.externalOrderId
    if (!accountId || !token || !tradeId) {
      return { ok: false, offline: true, error: "OANDA close params missing" }
    }
    return { ...(await closeOandaTrade(accountId, token, tradeId)), provider: "oanda" }
  }

  if (provider === "ibkr") {
    const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
    const accountId = conn?.login || conn?.metaApiAccountId
    const token = decryptSecret(conn?.passwordEnc) || "gateway"
    const volume = trade.lotSize && trade.lotSize > 0 ? trade.lotSize : 0.01
    return {
      ...(await closeIbkrPosition(accountId, token, {
        symbol: trade.pair,
        quantity: unitsFromLots(trade.pair, volume),
        side: trade.direction === "long" ? "BUY" : "SELL",
      })),
      provider: "ibkr",
    }
  }

  return { ok: false, offline: true, error: `No close adapter for ${provider}` }
}

export async function syncProviderBalance(account) {
  const conn = await MetaApiConnection.findOne({ brokerAccountId: account._id })
  if (!conn) return { ok: false, error: "No connection record" }

  if (account.provider === "oanda") {
    const token = decryptSecret(conn.passwordEnc)
    const accountId = conn.login || conn.metaApiAccountId
    return getOandaAccountSummary(accountId, token)
  }
  if (account.provider === "ibkr") {
    const token = decryptSecret(conn.passwordEnc) || "gateway"
    const accountId = conn.login || conn.metaApiAccountId
    return getIbkrAccountSummary(accountId, token)
  }
  return { ok: false, offline: true, error: "Use MetaApi sync for metaapi provider" }
}
