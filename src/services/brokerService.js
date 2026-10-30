import crypto from "crypto"
import BrokerAccount from "../models/BrokerAccount.js"
import MetaApiConnection from "../models/MetaApiConnection.js"
import Strategy from "../models/Strategy.js"
import Trade from "../models/Trade.js"

const METAAPI_BASE = "https://mt-provisioning-api-v1.agiliumtrade.ai"

function encryptSecret(plain) {
  if (!plain) return null
  const key = crypto
    .createHash("sha256")
    .update(process.env.JWT_SECRET || "dev-secret-for-local-only")
    .digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

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

export function sanitizeBroker(account) {
  const o = account.toObject ? account.toObject() : { ...account }
  if (o.credentials) {
    o.credentials = {
      encrypted: true,
      loginHint: o.credentials.loginHint,
      serverHint: o.credentials.serverHint,
      accountIdHint: o.credentials.accountIdHint,
    }
  }
  return o
}

/**
 * Attempt MetaApi provisioning when METAAPI_TOKEN is set.
 * Without token: local "paper-connected" mode for demo/testing.
 */
export async function provisionMetaApi({ login, password, server, platform = "mt5", name }) {
  const token = process.env.METAAPI_TOKEN
  if (!token) {
    return {
      ok: true,
      mode: "offline",
      metaApiAccountId: `local-${crypto.randomBytes(8).toString("hex")}`,
      message:
        "METAAPI_TOKEN not set — account stored in offline/demo mode. Add token after MetaApi location verification for live cloud terminals.",
    }
  }

  try {
    const res = await fetch(`${METAAPI_BASE}/users/current/accounts`, {
      method: "POST",
      headers: {
        "auth-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: name || `Altra-${login}`,
        type: "cloud",
        login,
        password,
        server,
        platform,
        magic: 0,
        quoteStreamingIntervalInSeconds: 2.5,
      }),
    })
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
    if (!res.ok) {
      return {
        ok: false,
        mode: "metaapi",
        error: data.message || data.error || `MetaApi HTTP ${res.status}`,
      }
    }
    return {
      ok: true,
      mode: "metaapi",
      metaApiAccountId: data.id || data._id || data.accountId,
      raw: data,
    }
  } catch (err) {
    return { ok: false, mode: "metaapi", error: err.message }
  }
}

export async function createBrokerAccount(userId, payload) {
  const {
    name,
    type = "demo",
    provider = "metaapi",
    login,
    password,
    server,
    platform = "mt5",
    oandaAccountId,
    oandaToken,
    ibkrAccountId,
    propFirmLimits,
    isNewsFilterEnabled = true,
    newsFilters,
    newsFilterCustom,
    balance = 10000,
  } = payload

  if (!name?.trim()) {
    throw Object.assign(new Error("Account name is required"), { status: 400 })
  }

  const account = await BrokerAccount.create({
    userId,
    name: name.trim(),
    type,
    provider,
    status: "disconnected",
    balance: Number(balance) || 0,
    equity: Number(balance) || 0,
    propFirmLimits: propFirmLimits || undefined,
    isNewsFilterEnabled,
    newsFilters: newsFilters || ["FOMC", "CPI", "NFP", "GDP", "ECB", "BOE"],
    newsFilterCustom: newsFilterCustom || [],
    credentials: {
      encrypted: true,
      vaultId: crypto.randomUUID(),
      loginHint: login ? String(login).slice(0, 4) + "***" : undefined,
      serverHint: server || undefined,
      accountIdHint: oandaAccountId || ibkrAccountId || undefined,
    },
  })

  if (provider === "metaapi") {
    if (!login || !password || !server) {
      await BrokerAccount.findByIdAndDelete(account._id)
      throw Object.assign(
        new Error("MetaApi requires login, password, and server"),
        { status: 400 }
      )
    }
    const provision = await provisionMetaApi({
      login,
      password,
      server,
      platform,
      name: account.name,
    })
    const conn = await MetaApiConnection.create({
      userId,
      brokerAccountId: account._id,
      login,
      server,
      platform,
      passwordEnc: encryptSecret(password),
      metaApiAccountId: provision.metaApiAccountId || null,
      state: provision.ok ? "deployed" : "failed",
      lastError: provision.ok ? null : provision.error,
      lastConnectedAt: provision.ok ? new Date() : null,
    })
    account.metaApiConnectionId = conn._id
    if (provision.ok) {
      account.status = type === "live" ? "live" : "connected"
      account.lastSync = new Date()
    } else {
      account.status = "disconnected"
    }
    await account.save()
    return {
      account: sanitizeBroker(account),
      connection: {
        state: conn.state,
        platform: conn.platform,
        server: conn.server,
        loginHint: account.credentials.loginHint,
        metaApiAccountId: conn.metaApiAccountId,
        mode: provision.mode,
        message: provision.message || provision.error || null,
      },
    }
  }

  if (provider === "oanda") {
    if (!oandaAccountId || !oandaToken) {
      await BrokerAccount.findByIdAndDelete(account._id)
      throw Object.assign(new Error("OANDA requires account id and API token"), { status: 400 })
    }
    account.credentials.vaultId = crypto.randomUUID()
    account.credentials.accountIdHint = String(oandaAccountId).slice(0, 6) + "***"
    // Store token encrypted in meta connection-like field via notes blob is wrong —
    // use MetaApiConnection table generically for secret storage label
    await MetaApiConnection.create({
      userId,
      brokerAccountId: account._id,
      login: String(oandaAccountId),
      server: "oanda",
      platform: "mt5",
      passwordEnc: encryptSecret(oandaToken),
      metaApiAccountId: String(oandaAccountId),
      state: process.env.OANDA_API_READY === "true" ? "deployed" : "deployed",
      lastConnectedAt: new Date(),
    })
    account.status = "connected"
    account.lastSync = new Date()
    await account.save()
    return {
      account: sanitizeBroker(account),
      connection: {
        state: "deployed",
        mode: "oanda",
        message: "OANDA account registered. Live order routing activates with API credentials verified.",
      },
    }
  }

  if (provider === "ibkr") {
    if (!ibkrAccountId) {
      await BrokerAccount.findByIdAndDelete(account._id)
      throw Object.assign(new Error("IBKR requires account id"), { status: 400 })
    }
    await MetaApiConnection.create({
      userId,
      brokerAccountId: account._id,
      login: String(ibkrAccountId),
      server: "ibkr",
      platform: "mt5",
      passwordEnc: encryptSecret(payload.ibkrToken || "gateway"),
      metaApiAccountId: String(ibkrAccountId),
      state: "deployed",
      lastConnectedAt: new Date(),
    })
    account.status = "connected"
    account.credentials.accountIdHint = String(ibkrAccountId).slice(0, 4) + "***"
    account.lastSync = new Date()
    await account.save()
    return {
      account: sanitizeBroker(account),
      connection: {
        state: "deployed",
        mode: "ibkr",
        message: "IBKR account registered for Client Portal / Gateway integration.",
      },
    }
  }

  account.status = "connected"
  await account.save()
  return { account: sanitizeBroker(account), connection: { state: "deployed", mode: "others" } }
}

export async function listBrokerAccounts(userId) {
  const accounts = await BrokerAccount.find({ userId })
    .populate("assignedStrategy", "name status sourceType")
    .sort({ updatedAt: -1 })
  return accounts.map(sanitizeBroker)
}

export async function getBrokerAccount(userId, id) {
  const account = await BrokerAccount.findOne({ _id: id, userId }).populate(
    "assignedStrategy",
    "name status"
  )
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  return sanitizeBroker(account)
}

export async function disconnectBroker(userId, id) {
  const account = await BrokerAccount.findOne({ _id: id, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  account.status = "disconnected"
  await account.save()
  if (account.metaApiConnectionId) {
    await MetaApiConnection.findByIdAndUpdate(account.metaApiConnectionId, {
      state: "undeployed",
    })
  }
  return sanitizeBroker(account)
}

export async function reconnectBroker(userId, id) {
  const account = await BrokerAccount.findOne({ _id: id, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  const conn = account.metaApiConnectionId
    ? await MetaApiConnection.findById(account.metaApiConnectionId)
    : null

  if (account.provider === "metaapi" && conn && process.env.METAAPI_TOKEN) {
    const password = decryptSecret(conn.passwordEnc)
    const provision = await provisionMetaApi({
      login: conn.login,
      password,
      server: conn.server,
      platform: conn.platform,
      name: account.name,
    })
    if (!provision.ok) {
      conn.state = "failed"
      conn.lastError = provision.error
      await conn.save()
      throw Object.assign(new Error(provision.error || "Reconnect failed"), { status: 502 })
    }
    conn.state = "deployed"
    conn.metaApiAccountId = provision.metaApiAccountId || conn.metaApiAccountId
    conn.lastConnectedAt = new Date()
    conn.lastError = null
    await conn.save()
  } else if (conn) {
    conn.state = "deployed"
    conn.lastConnectedAt = new Date()
    await conn.save()
  }

  account.status = account.type === "live" ? "live" : "connected"
  account.lastSync = new Date()
  await account.save()
  return sanitizeBroker(account)
}

/**
 * Enforce ONE strategy per account.
 * Also prevents the same strategy from being assigned to a second account.
 */
export async function assignStrategy(userId, accountId, strategyId) {
  const account = await BrokerAccount.findOne({ _id: accountId, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  if (!["connected", "live", "testing"].includes(account.status)) {
    throw Object.assign(new Error("Connect the account before assigning a strategy"), {
      status: 400,
    })
  }

  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) throw Object.assign(new Error("Strategy not found"), { status: 404 })
  if (!["approved", "demo", "live"].includes(strategy.status)) {
    throw Object.assign(
      new Error("Only approved, demo, or live strategies can be assigned"),
      { status: 400 }
    )
  }

  if (account.assignedStrategy && String(account.assignedStrategy) === String(strategyId)) {
    return { account: sanitizeBroker(account), message: "Strategy already assigned" }
  }

  const conflictAccount = await BrokerAccount.findOne({
    assignedStrategy: strategyId,
    _id: { $ne: accountId },
  })
  if (conflictAccount) {
    throw Object.assign(
      new Error(
        "This strategy is already assigned to another broker account. Unassign it first (one strategy ↔ one account)."
      ),
      { status: 409 }
    )
  }

  if (account.assignedStrategy) {
    account.assignmentHistory.push({
      strategyId: account.assignedStrategy,
      assignedAt: account.updatedAt,
      unassignedAt: new Date(),
    })
  }

  account.assignedStrategy = strategyId
  account.assignmentHistory.push({
    strategyId,
    assignedAt: new Date(),
  })
  await account.save()

  if (strategy.status === "approved") {
    strategy.status = account.type === "demo" ? "demo" : strategy.status
    await strategy.save()
  }

  const populated = await BrokerAccount.findById(account._id).populate(
    "assignedStrategy",
    "name status"
  )
  return {
    account: sanitizeBroker(populated),
    message: "Strategy assigned (one strategy per account enforced)",
  }
}

export async function unassignStrategy(userId, accountId) {
  const account = await BrokerAccount.findOne({ _id: accountId, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })
  if (account.assignedStrategy) {
    account.assignmentHistory.push({
      strategyId: account.assignedStrategy,
      unassignedAt: new Date(),
    })
  }
  account.assignedStrategy = null
  await account.save()
  return { account: sanitizeBroker(account), message: "Strategy unassigned" }
}

export async function updateBrokerSettings(userId, accountId, body) {
  const account = await BrokerAccount.findOne({ _id: accountId, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })

  if (typeof body.isNewsFilterEnabled === "boolean") {
    account.isNewsFilterEnabled = body.isNewsFilterEnabled
  }
  if (Array.isArray(body.newsFilters)) account.newsFilters = body.newsFilters
  if (Array.isArray(body.newsFilterCustom)) account.newsFilterCustom = body.newsFilterCustom
  if (body.propFirmLimits && typeof body.propFirmLimits === "object") {
    account.propFirmLimits = { ...account.propFirmLimits.toObject?.() || account.propFirmLimits, ...body.propFirmLimits }
  }
  if (body.balance != null) {
    account.balance = Number(body.balance)
    account.equity = Number(body.equity ?? body.balance)
    account.lastSync = new Date()
  }
  if (body.notes != null) account.notes = String(body.notes)
  await account.save()
  return sanitizeBroker(account)
}

export async function syncBalance(userId, accountId) {
  const account = await BrokerAccount.findOne({ _id: accountId, userId })
  if (!account) throw Object.assign(new Error("Broker account not found"), { status: 404 })

  if (account.provider === "metaapi" && process.env.METAAPI_TOKEN && account.metaApiConnectionId) {
    const conn = await MetaApiConnection.findById(account.metaApiConnectionId)
    // Live MetaApi account information API would go here with account id
    account.lastSync = new Date()
    await account.save()
    return {
      account: sanitizeBroker(account),
      message: conn?.metaApiAccountId
        ? "Sync acknowledged (MetaApi account linked)"
        : "No MetaApi account id yet",
    }
  }

  // Offline: recompute equity from closed trades delta optional
  const closed = await Trade.find({
    userId,
    brokerAccountId: accountId,
    status: "closed",
  })
  const pnl = closed.reduce((s, t) => s + (t.pnl || 0), 0)
  account.equity = (account.balance || 0) + pnl
  account.lastSync = new Date()
  await account.save()
  return { account: sanitizeBroker(account), message: "Balance/equity refreshed (offline mode)" }
}
