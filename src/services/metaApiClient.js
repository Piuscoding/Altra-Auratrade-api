/**
 * MetaApi REST client for account deploy, info, and trade execution.
 * Docs: https://metaapi.cloud/docs/client/
 */

const PROVISIONING = "https://mt-provisioning-api-v1.agiliumtrade.ai"
const CLIENT_API = process.env.METAAPI_CLIENT_API_URL || "https://mt-client-api-v1.new-york.agiliumtrade.ai"

function token() {
  return process.env.METAAPI_TOKEN || ""
}

function headers() {
  return {
    "auth-token": token(),
    "Content-Type": "application/json",
  }
}

export function isMetaApiConfigured() {
  return Boolean(token())
}

export async function getAccountInformation(metaApiAccountId) {
  if (!token() || !metaApiAccountId || String(metaApiAccountId).startsWith("local-")) {
    return { ok: false, offline: true, error: "No live MetaApi account id" }
  }
  try {
    const res = await fetch(
      `${CLIENT_API}/users/current/accounts/${metaApiAccountId}/account-information`,
      { headers: headers() }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, offline: false, error: data.message || data.error || `HTTP ${res.status}`, data }
    }
    return { ok: true, offline: false, data }
  } catch (err) {
    return { ok: false, offline: false, error: err.message }
  }
}

/**
 * Place market order via MetaApi.
 * volume is in lots. symbol e.g. EURUSD
 */
export async function placeMarketOrder(metaApiAccountId, {
  symbol,
  actionType,
  volume,
  stopLoss,
  takeProfit,
  comment = "Altra-AuraTrade",
}) {
  if (!token()) {
    return { ok: false, offline: true, error: "METAAPI_TOKEN not set" }
  }
  if (!metaApiAccountId || String(metaApiAccountId).startsWith("local-")) {
    return { ok: false, offline: true, error: "Account is offline/local — not a live MetaApi id" }
  }

  const body = {
    actionType, // ORDER_TYPE_BUY | ORDER_TYPE_SELL
    symbol,
    volume: Number(volume),
    comment,
  }
  if (stopLoss != null && !Number.isNaN(Number(stopLoss))) body.stopLoss = Number(stopLoss)
  if (takeProfit != null && !Number.isNaN(Number(takeProfit))) body.takeProfit = Number(takeProfit)

  try {
    const res = await fetch(
      `${CLIENT_API}/users/current/accounts/${metaApiAccountId}/trade`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        offline: false,
        error: data.message || data.error || data.stringCode || `HTTP ${res.status}`,
        data,
      }
    }
    return {
      ok: true,
      offline: false,
      orderId: data.orderId || data.positionId || data.numericCode,
      data,
    }
  } catch (err) {
    return { ok: false, offline: false, error: err.message }
  }
}

export async function closePosition(metaApiAccountId, positionId) {
  if (!token() || !metaApiAccountId || String(metaApiAccountId).startsWith("local-")) {
    return { ok: false, offline: true, error: "Cannot close on offline account" }
  }
  try {
    const res = await fetch(
      `${CLIENT_API}/users/current/accounts/${metaApiAccountId}/trade`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          actionType: "POSITION_CLOSE_ID",
          positionId,
        }),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.message || data.error || `HTTP ${res.status}`, data }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export async function deployAccount(metaApiAccountId) {
  if (!token() || !metaApiAccountId) {
    return { ok: false, error: "Missing token or account id" }
  }
  try {
    const res = await fetch(
      `${PROVISIONING}/users/current/accounts/${metaApiAccountId}/deploy`,
      { method: "POST", headers: headers() }
    )
    if (res.status === 204 || res.ok) return { ok: true }
    const data = await res.json().catch(() => ({}))
    return { ok: false, error: data.message || `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export { CLIENT_API, PROVISIONING }
