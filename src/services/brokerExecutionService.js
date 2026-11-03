import MetaApiConnection from "../models/MetaApiConnection.js"
import BrokerAccount from "../models/BrokerAccount.js"
import { placeMarketOrder, closePosition, getAccountInformation, isMetaApiConfigured } from "./metaApiClient.js"
import { placeOandaMarketOrder, closeOandaTrade, getOandaAccountSummary } from "./oandaClient.js"
import { placeIbkrMarketOrder, getIbkrAccountSummary } from "./ibkrClient.js"
import crypto from "crypto"

function decryptSecret(blob) {
  if (!blob) return null
  try {
    const buf = Buffer.from(blob, "base64")
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const key = crypto
      .createHash("sha256")
      .update(process.env.JWT_SECRET || "dev-secret-for-local-only")
      .digest()
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}

function friendlyError(err) {
  if (!err) return "Broker request failed"
  const s = String(err.message || err)
  if (s.length > 200) return s.slice(0, 200)
  return s
}

async function loadConnection(brokerAccountId) {
  return MetaApiConnection.findOne({ brokerAccountId })
}

/**
 * Place live order according to broker provider.
 */
export async function executeMarketOrder(brokerAccount, trade) {
  const provider = brokerAccount?.provider || "paper"
  const volume = trade.lotSize && trade.lotSize > 0 ? trade.lotSize : 0.01
  const conn = await loadConnection(brokerAccount._id)

  if (provider === "metaapi") {
    if (!isMetaApiConfigured()) {
      return { ok: false, offline: true, provider, error: "METAAPI_TOKEN not set" }
    }
    const accountId = conn?.metaApiAccountId
    if (!accountId || String(accountId).startsWith("local-")) {
      return { ok: false, offline: true, provider, error: "MetaApi account is local/offline" }
    }
    const result = await placeMarketOrder(accountId, {
      symbol: trade.pair,
      actionType: trade.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      comment: "Altra-AuraTrade",
    })
    return { ...result, provider }
  }

  if (provider === "oanda") {
    const accountId = conn?.metaApiAccountId || conn?.login
    const token = decryptSecret(conn?.passwordEnc)
    if (!accountId || !token) {
      return { ok: false, offline: true, provider, error: "OANDA account id or token missing" }
    }
    // OANDA units: approximate 100000 units ≈ 1 standard lot for FX
    const unitsRaw = Math.max(1, Math.round(volume * 100000))
    const units = trade.direction === "long" ? unitsRaw : -unitsRaw
    const result = await placeOandaMarketOrder(accountId, token, {
      instrument: trade.pair,
      units,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
    })
    return { ...result, provider }
  }

  if (provider === "ibkr") {
    const accountId =
      conn?.metaApiAccountId ||
      brokerAccount.credentials?.accountIdHint ||
      process.env.IBKR_ACCOUNT_ID
    if (!accountId) {
      return { ok: false, offline: true, provider, error: "IBKR account id missing" }
    }
    // FX on IBKR: symbol often base currency, quantity in base units
    const base = String(trade.pair).slice(0, 3)
    const quantity = Math.max(1, Math.round(volume * 25000))
    const result = await placeIbkrMarketOrder(accountId, {
      symbol: base,
      side: trade.direction === "long" ? "BUY" : "SELL",
      quantity,
      secType: "CASH",
      exchange: "IDEALPRO",
      currency: String(trade.pair).slice(3, 6) || "USD",
    })
    return { ...result, provider }
  }

  return { ok: false, offline: true, provider, error: `No live adapter for provider ${provider}` }
}

export async function executeCloseOrder(brokerAccount, trade) {
  const provider = brokerAccount?.provider || "paper"
  const conn = await loadConnection(brokerAccount._id)
  const orderId = trade.metadata?.orderId || trade.metadata?.metaApiOrderId

  if (provider === "metaapi") {
    if (!isMetaApiConfigured() || !orderId) {
      return { ok: false, offline: true, provider, error: "Cannot close MetaApi without order id" }
    }
    const accountId = conn?.metaApiAccountId
    if (!accountId || String(accountId).startsWith("local-")) {
      return { ok: false, offline: true, provider, error: "Offline MetaApi account" }
    }
    return { ...(await closePosition(accountId, orderId)), provider }
  }

  if (provider === "oanda") {
    const accountId = conn?.metaApiAccountId || conn?.login
    const token = decryptSecret(conn?.passwordEnc)
    if (!accountId || !token || !orderId) {
      return { ok: false, offline: true, provider, error: "OANDA close requires trade id" }
    }
    return { ...(await closeOandaTrade(accountId, token, orderId)), provider }
  }

  if (provider === "ibkr") {
    return {
      ok: false,
      provider,
      error: "IBKR close via opposite order — use Terminal close with paper tracking or IBKR UI",
    }
  }

  return { ok: false, offline: true, provider, error: "No close adapter" }
}

export async function syncBrokerLiveBalance(brokerAccount) {
  const provider = brokerAccount.provider
  const conn = await loadConnection(brokerAccount._id)

  if (provider === "metaapi" && isMetaApiConfigured()) {
    const accountId = conn?.metaApiAccountId
    if (accountId && !String(accountId).startsWith("local-")) {
      const info = await getAccountInformation(accountId)
      if (info.ok && info.data) {
        return {
          ok: true,
          provider,
          balance: info.data.balance != null ? Number(info.data.balance) : null,
          equity: info.data.equity != null ? Number(info.data.equity) : null,
          currency: info.data.currency,
        }
      }
      return { ok: false, provider, error: info.error }
    }
  }

  if (provider === "oanda") {
    const accountId = conn?.metaApiAccountId || conn?.login
    const token = decryptSecret(conn?.passwordEnc)
    if (accountId && token) {
      const info = await getOandaAccountSummary(accountId, token)
      if (info.ok) {
        return {
          ok: true,
          provider,
          balance: info.balance,
          equity: info.equity,
          currency: info.currency,
        }
      }
      return { ok: false, provider, error: info.error }
    }
  }

  if (provider === "ibkr") {
    const accountId = conn?.metaApiAccountId || process.env.IBKR_ACCOUNT_ID
    const token = decryptSecret(conn?.passwordEnc)
    if (accountId) {
      const info = await getIbkrAccountSummary(accountId, token)
      if (info.ok) {
        return {
          ok: true,
          provider,
          balance: info.balance,
          equity: info.equity,
          currency: info.currency,
        }
      }
      return { ok: false, provider, error: info.error }
    }
  }

  return { ok: false, offline: true, provider, error: "Live balance unavailable" }
}

export function executionMethodForProvider(provider) {
  if (provider === "metaapi") return "metaapi"
  if (provider === "oanda" || provider === "ibkr") return "direct_api"
  return "paper"
}
