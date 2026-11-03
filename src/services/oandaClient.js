/**
 * OANDA v20 REST — practice or live
 * OANDA_API_URL=https://api-fxpractice.oanda.com | https://api-fxtrade.oanda.com
 */

function baseUrl() {
  return (process.env.OANDA_API_URL || "https://api-fxpractice.oanda.com").replace(/\/$/, "")
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept-Datetime-Format": "RFC3339",
  }
}

export function toOandaInstrument(pair) {
  const p = String(pair).toUpperCase().replace(/[^A-Z]/g, "")
  if (p.length === 6) return `${p.slice(0, 3)}_${p.slice(3)}`
  if (p.includes("_")) return p
  return p
}

function sanitizeOandaError(data, status) {
  const msg =
    data?.errorMessage ||
    data?.message ||
    data?.errorCode ||
    (typeof data === "string" ? data : null) ||
    `OANDA request failed (${status || "network"})`
  // Never return raw stack or full payload to clients
  return String(msg).slice(0, 240)
}

export function isOandaConfiguredEnv() {
  return Boolean(process.env.OANDA_API_URL || process.env.OANDA_ENV)
}

export function oandaEnvironmentLabel() {
  const u = baseUrl()
  if (u.includes("fxtrade")) return "live"
  return "practice"
}

export async function getOandaAccountSummary(accountId, token) {
  if (!accountId || !token) {
    return { ok: false, error: "Missing OANDA account id or token" }
  }
  try {
    const res = await fetch(`${baseUrl()}/v3/accounts/${accountId}/summary`, {
      headers: headers(token),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: sanitizeOandaError(data, res.status), status: res.status }
    }
    const a = data.account || {}
    return {
      ok: true,
      balance: Number(a.balance),
      equity: Number(a.NAV ?? a.balance),
      currency: a.currency,
      openTradeCount: Number(a.openTradeCount || 0),
      openPositionCount: Number(a.openPositionCount || 0),
      marginUsed: Number(a.marginUsed || 0),
      marginAvailable: Number(a.marginAvailable || 0),
      environment: oandaEnvironmentLabel(),
    }
  } catch (err) {
    return { ok: false, error: "Could not reach OANDA — check network and OANDA_API_URL" }
  }
}

export async function placeOandaMarketOrder(
  accountId,
  token,
  { instrument, units, stopLossPrice, takeProfitPrice, clientExtensions }
) {
  if (!accountId || !token) {
    return { ok: false, offline: true, error: "Missing OANDA credentials" }
  }
  const body = {
    order: {
      type: "MARKET",
      instrument: toOandaInstrument(instrument),
      units: String(units),
      timeInForce: "FOK",
      positionFill: "DEFAULT",
    },
  }
  if (stopLossPrice != null && Number.isFinite(Number(stopLossPrice))) {
    body.order.stopLossOnFill = { price: String(stopLossPrice) }
  }
  if (takeProfitPrice != null && Number.isFinite(Number(takeProfitPrice))) {
    body.order.takeProfitOnFill = { price: String(takeProfitPrice) }
  }
  if (clientExtensions) body.order.clientExtensions = clientExtensions

  try {
    const res = await fetch(`${baseUrl()}/v3/accounts/${accountId}/orders`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        error: sanitizeOandaError(data, res.status),
        status: res.status,
        orderStatus: "rejected",
      }
    }

    const fill = data.orderFillTransaction || data.orderCreateTransaction || {}
    const cancel = data.orderCancelTransaction
    const reject = data.orderRejectTransaction

    if (reject) {
      return {
        ok: false,
        error: sanitizeOandaError(reject, 400),
        orderStatus: "rejected",
        orderId: reject.id || null,
      }
    }
    if (cancel && !fill.id) {
      return {
        ok: false,
        error: cancel.reason || "Order cancelled",
        orderStatus: "cancelled",
        orderId: cancel.orderID || cancel.id || null,
      }
    }

    const filledUnits = Math.abs(Number(fill.units || units || 0))
    const requested = Math.abs(Number(units))
    let orderStatus = "filled"
    if (filledUnits > 0 && filledUnits < requested * 0.999) orderStatus = "partial"
    if (!fill.id && data.orderCreateTransaction) orderStatus = "pending"

    return {
      ok: true,
      orderId: fill.id || data.orderCreateTransaction?.id || null,
      tradeId: fill.tradeOpened?.tradeID || fill.tradeReduced?.tradeID || null,
      fillPrice: fill.price != null ? Number(fill.price) : null,
      filledUnits,
      orderStatus,
      pl: fill.pl != null ? Number(fill.pl) : null,
      environment: oandaEnvironmentLabel(),
    }
  } catch (err) {
    return { ok: false, error: "OANDA order request failed — check credentials and instrument" }
  }
}

export async function getOandaOrder(accountId, token, orderId) {
  if (!accountId || !token || !orderId) {
    return { ok: false, error: "Missing OANDA order lookup fields" }
  }
  try {
    const res = await fetch(`${baseUrl()}/v3/accounts/${accountId}/orders/${orderId}`, {
      headers: headers(token),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: sanitizeOandaError(data, res.status) }
    }
    const order = data.order || {}
    const state = String(order.state || "").toUpperCase()
    let orderStatus = "pending"
    if (state === "FILLED") orderStatus = "filled"
    else if (state === "CANCELLED") orderStatus = "cancelled"
    else if (state.includes("REJECT")) orderStatus = "rejected"
    else if (state === "TRIGGERED") orderStatus = "filled"
    return {
      ok: true,
      orderId: order.id,
      orderStatus,
      state: order.state,
      units: order.units,
      instrument: order.instrument,
      price: order.price != null ? Number(order.price) : null,
    }
  } catch {
    return { ok: false, error: "Could not fetch OANDA order status" }
  }
}

export async function getOandaOpenTrades(accountId, token) {
  if (!accountId || !token) return { ok: false, error: "Missing OANDA credentials" }
  try {
    const res = await fetch(`${baseUrl()}/v3/accounts/${accountId}/openTrades`, {
      headers: headers(token),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: sanitizeOandaError(data, res.status) }
    return {
      ok: true,
      trades: (data.trades || []).map((t) => ({
        id: t.id,
        instrument: t.instrument,
        currentUnits: Number(t.currentUnits),
        price: Number(t.price),
        unrealizedPL: Number(t.unrealizedPL || 0),
      })),
    }
  } catch {
    return { ok: false, error: "Could not list OANDA open trades" }
  }
}

export async function closeOandaTrade(accountId, token, tradeId) {
  if (!accountId || !token || !tradeId) {
    return { ok: false, offline: true, error: "Missing OANDA close fields" }
  }
  try {
    const res = await fetch(
      `${baseUrl()}/v3/accounts/${accountId}/trades/${tradeId}/close`,
      {
        method: "PUT",
        headers: headers(token),
        body: JSON.stringify({}),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        error: sanitizeOandaError(data, res.status),
        orderStatus: "rejected",
      }
    }
    const tx = data.orderFillTransaction || data.orderCreateTransaction || {}
    return {
      ok: true,
      orderId: tx.id || null,
      fillPrice: tx.price != null ? Number(tx.price) : null,
      pl: tx.pl != null ? Number(tx.pl) : null,
      orderStatus: "filled",
    }
  } catch {
    return { ok: false, error: "OANDA close failed — trade may already be closed" }
  }
}
