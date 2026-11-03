/**
 * Interactive Brokers Client Portal Gateway
 * IBKR_GATEWAY_URL=https://localhost:5000  (or your gateway host)
 * Requires local CP Gateway / Client Portal running and authenticated.
 */

function baseUrl() {
  return (process.env.IBKR_GATEWAY_URL || "https://localhost:5000").replace(/\/$/, "")
}

function sanitizeIbkrError(data, status) {
  if (typeof data === "string") return data.slice(0, 240)
  const msg =
    data?.error ||
    data?.message ||
    data?.errorMessage ||
    (Array.isArray(data) && data[0]?.message) ||
    `IBKR gateway error (${status || "network"})`
  return String(msg).slice(0, 240)
}

async function gatewayFetch(path, { method = "GET", body, token } = {}) {
  const url = `${baseUrl()}/v1/api${path}`
  const headers = { Accept: "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers["Content-Type"] = "application/json"

  // Gateway often uses self-signed certs in local setups
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { message: text?.slice(0, 200) }
  }
  return { res, data }
}

/**
 * Tickle / validate session; attempt soft recovery via auth status.
 */
export async function recoverIbkrSession(token) {
  try {
    // Keepalive
    const tickle = await gatewayFetch("/tickle", { method: "POST", token })
    if (tickle.res.ok) {
      return {
        ok: true,
        recovered: false,
        authenticated: Boolean(tickle.data?.iserver?.authStatus?.authenticated ?? true),
        message: "Session active",
      }
    }

    // Auth status
    const status = await gatewayFetch("/iserver/auth/status", { token })
    const authenticated = Boolean(status.data?.authenticated)
    if (authenticated) {
      return { ok: true, recovered: true, authenticated: true, message: "Session restored" }
    }

    // Try reauthenticate endpoint (gateway-side SSO)
    const reauth = await gatewayFetch("/iserver/reauthenticate", { method: "POST", token })
    if (reauth.res.ok || reauth.data?.authenticated) {
      return {
        ok: true,
        recovered: true,
        authenticated: true,
        message: "Reauthenticated via gateway",
      }
    }

    return {
      ok: false,
      recovered: false,
      authenticated: false,
      error:
        "IBKR gateway session expired — log in at the Client Portal Gateway (usually https://localhost:5000) and retry",
    }
  } catch {
    return {
      ok: false,
      error:
        "Cannot reach IBKR Client Portal Gateway — start it and set IBKR_GATEWAY_URL if needed",
    }
  }
}

export async function getIbkrAuthStatus(token) {
  try {
    const { res, data } = await gatewayFetch("/iserver/auth/status", { token })
    if (!res.ok) {
      const recovery = await recoverIbkrSession(token)
      if (recovery.ok) return { ok: true, authenticated: true, recovered: recovery.recovered }
      return { ok: false, authenticated: false, error: recovery.error || sanitizeIbkrError(data, res.status) }
    }
    return {
      ok: true,
      authenticated: Boolean(data.authenticated),
      competing: Boolean(data.competing),
      connected: Boolean(data.connected),
    }
  } catch {
    return {
      ok: false,
      authenticated: false,
      error: "IBKR gateway unreachable",
    }
  }
}

export async function getIbkrAccountSummary(accountId, token) {
  if (!accountId) {
    return { ok: false, error: "Missing IBKR account id" }
  }
  try {
    const auth = await getIbkrAuthStatus(token)
    if (!auth.ok || auth.authenticated === false) {
      return {
        ok: false,
        error: auth.error || "IBKR not authenticated — complete gateway login",
      }
    }

    const { res, data } = await gatewayFetch(
      `/portfolio/${encodeURIComponent(accountId)}/summary`,
      { token }
    )
    if (!res.ok) {
      return { ok: false, error: sanitizeIbkrError(data, res.status) }
    }
    // CP Gateway summary is often array of { tag, value, currency }
    const map = {}
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row.tag) map[row.tag] = row.value
      }
    } else if (data && typeof data === "object") {
      Object.assign(map, data)
    }
    const balance = Number(map.TotalCashValue ?? map.CashBalance ?? map.balance ?? 0)
    const equity = Number(map.NetLiquidation ?? map.equity ?? balance)
    return {
      ok: true,
      balance,
      equity,
      currency: map.Currency || map.currency || "USD",
      buyingPower: map.BuyingPower != null ? Number(map.BuyingPower) : null,
    }
  } catch {
    return { ok: false, error: "IBKR account summary failed — check gateway session" }
  }
}

export async function placeIbkrMarketOrder(
  accountId,
  token,
  { symbol, fxPair, side, quantity }
) {
  if (!accountId) return { ok: false, offline: true, error: "Missing IBKR account id" }

  const auth = await getIbkrAuthStatus(token)
  if (!auth.ok || auth.authenticated === false) {
    return {
      ok: false,
      error: auth.error || "IBKR session not authenticated",
      orderStatus: "rejected",
    }
  }

  const pair = (fxPair || symbol || "").replace(/[^A-Z]/gi, "").toUpperCase()
  const conidBody = {
    symbol: pair.length === 6 ? pair.slice(0, 3) : pair,
    secType: "CASH",
    name: true,
  }
  // Second currency for FX
  if (pair.length === 6) {
    conidBody.currency = pair.slice(3)
  }

  try {
    // Search contract
    const search = await gatewayFetch(
      `/iserver/secdef/search?symbol=${encodeURIComponent(conidBody.symbol)}&secType=CASH`,
      { token }
    )
    const contracts = Array.isArray(search.data) ? search.data : []
    const match =
      contracts.find((c) =>
        String(c.description || c.companyName || "")
          .toUpperCase()
          .includes(pair.slice(3) || "")
      ) || contracts[0]
    const conid = match?.conid
    if (!conid) {
      return {
        ok: false,
        error: `IBKR could not resolve FX contract for ${pair}`,
        orderStatus: "rejected",
      }
    }

    const order = {
      orders: [
        {
          acctId: accountId,
          conid: Number(conid),
          orderType: "MKT",
          side: side === "SELL" || side === "short" ? "SELL" : "BUY",
          quantity: Number(quantity) || 1,
          tif: "DAY",
        },
      ],
    }

    const { res, data } = await gatewayFetch(`/iserver/account/${accountId}/orders`, {
      method: "POST",
      body: order,
      token,
    })

    if (!res.ok) {
      return {
        ok: false,
        error: sanitizeIbkrError(data, res.status),
        orderStatus: "rejected",
      }
    }

    const first = Array.isArray(data) ? data[0] : data
    // Message id confirmation flow
    if (first?.id && first?.message) {
      const confirm = await gatewayFetch(`/iserver/reply/${first.id}`, {
        method: "POST",
        body: { confirmed: true },
        token,
      })
      const conf = Array.isArray(confirm.data) ? confirm.data[0] : confirm.data
      return {
        ok: confirm.res.ok,
        orderId: conf?.order_id || conf?.orderId || first.id,
        orderStatus: confirm.res.ok ? "submitted" : "rejected",
        error: confirm.res.ok ? null : sanitizeIbkrError(confirm.data, confirm.res.status),
        fillPrice: null,
      }
    }

    return {
      ok: true,
      orderId: first?.order_id || first?.orderId || first?.id || null,
      orderStatus: first?.order_status || "submitted",
      fillPrice: null,
    }
  } catch {
    return { ok: false, error: "IBKR order failed — check gateway and contract", orderStatus: "rejected" }
  }
}

export async function getIbkrOrderStatus(accountId, token, orderId) {
  try {
    const { res, data } = await gatewayFetch(`/iserver/account/order/status/${orderId}`, {
      token,
    })
    if (!res.ok) {
      return { ok: false, error: sanitizeIbkrError(data, res.status) }
    }
    const state = String(data?.order_status || data?.status || "").toLowerCase()
    let orderStatus = "pending"
    if (state.includes("fill") && state.includes("partial")) orderStatus = "partial"
    else if (state.includes("fill") || state === "executed") orderStatus = "filled"
    else if (state.includes("cancel")) orderStatus = "cancelled"
    else if (state.includes("reject") || state.includes("inactive")) orderStatus = "rejected"
    else if (state.includes("submit") || state.includes("presubmitted")) orderStatus = "submitted"
    return {
      ok: true,
      orderId,
      orderStatus,
      rawStatus: data?.order_status || data?.status,
      filledQuantity: data?.filledQuantity != null ? Number(data.filledQuantity) : null,
      avgPrice: data?.average_price != null ? Number(data.average_price) : null,
    }
  } catch {
    return { ok: false, error: "Could not fetch IBKR order status" }
  }
}

export async function closeIbkrPosition(accountId, token, { symbol, quantity, side }) {
  // Close = opposite market order
  const closeSide = side === "SELL" || side === "short" ? "BUY" : "SELL"
  return placeIbkrMarketOrder(accountId, token, {
    symbol,
    fxPair: symbol,
    side: closeSide,
    quantity,
  })
}
