import AuditLog from "../models/AuditLog.js"

export async function writeAudit({
  userId = null,
  actorRole = "user",
  action,
  resource = null,
  resourceId = null,
  summary,
  details = {},
  ip = null,
  success = true,
}) {
  try {
    return await AuditLog.create({
      userId,
      actorRole,
      action,
      resource,
      resourceId: resourceId ? String(resourceId) : null,
      summary,
      details,
      ip,
      success,
    })
  } catch (err) {
    console.error("[audit] write failed:", err.message)
    return null
  }
}

export async function listAuditLogs({ userId, action, limit = 100, admin = false } = {}) {
  const q = {}
  if (userId && !admin) q.userId = userId
  if (userId && admin) q.userId = userId
  if (action) q.action = action
  return AuditLog.find(q).sort({ createdAt: -1 }).limit(limit).populate("userId", "email firstName lastName")
}
