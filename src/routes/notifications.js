import { Router } from "express"
import { protect, loadUser, restrictTo } from "../middleware/auth.js"
import {
  getOrCreatePrefs,
  listNotifications,
  markRead,
  markAllRead,
  unreadCount,
  notifyUser,
} from "../services/notificationService.js"
import NotificationPreference from "../models/NotificationPreference.js"
import { listAuditLogs, writeAudit } from "../services/auditService.js"

const router = Router()
router.use(protect, loadUser)

router.get("/", async (req, res) => {
  try {
    const unreadOnly = req.query.unread === "1"
    const notifications = await listNotifications(req.user._id, {
      unreadOnly,
      limit: Number(req.query.limit) || 50,
    })
    const unread = await unreadCount(req.user._id)
    res.json({ notifications, unread })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list notifications" })
  }
})

router.get("/unread-count", async (req, res) => {
  try {
    const unread = await unreadCount(req.user._id)
    res.json({ unread })
  } catch (err) {
    res.status(500).json({ message: "Failed" })
  }
})

router.post("/:id/read", async (req, res) => {
  try {
    const n = await markRead(req.user._id, req.params.id)
    if (!n) return res.status(404).json({ message: "Not found" })
    res.json({ notification: n })
  } catch (err) {
    res.status(500).json({ message: "Failed" })
  }
})

router.post("/read-all", async (req, res) => {
  try {
    await markAllRead(req.user._id)
    res.json({ message: "All marked read" })
  } catch (err) {
    res.status(500).json({ message: "Failed" })
  }
})

router.get("/preferences", async (req, res) => {
  try {
    const prefs = await getOrCreatePrefs(req.user._id)
    res.json({ preferences: prefs })
  } catch (err) {
    res.status(500).json({ message: "Failed to load preferences" })
  }
})

router.put("/preferences", async (req, res) => {
  try {
    const prefs = await getOrCreatePrefs(req.user._id)
    const body = req.body || {}
    if (typeof body.inApp === "boolean") prefs.inApp = body.inApp
    if (typeof body.email === "boolean") prefs.email = body.email
    if (typeof body.telegram === "boolean") prefs.telegram = body.telegram
    if (typeof body.discord === "boolean") prefs.discord = body.discord
    if (body.telegramChatId !== undefined) prefs.telegramChatId = String(body.telegramChatId)
    if (body.discordWebhookUrl !== undefined) {
      prefs.discordWebhookUrl = String(body.discordWebhookUrl)
    }
    if (body.events && typeof body.events === "object") {
      prefs.events = { ...(prefs.events?.toObject?.() || prefs.events || {}), ...body.events }
    }
    await prefs.save()
    await writeAudit({
      userId: req.user._id,
      action: "notification.prefs_updated",
      resource: "NotificationPreference",
      resourceId: prefs._id,
      summary: "Notification preferences updated",
    })
    res.json({ preferences: prefs })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to save preferences" })
  }
})

router.post("/test", async (req, res) => {
  try {
    const channel = req.body?.channel || "inApp"
    const n = await notifyUser(req.user._id, {
      type: "system",
      title: "Test notification",
      body: `This is a test of the ${channel} channel from Altra-AuraTrade.`,
      severity: "info",
      meta: { test: true, channel },
    })
    res.json({ notification: n, message: "Test notification dispatched" })
  } catch (err) {
    res.status(500).json({ message: err.message || "Test failed" })
  }
})

router.get("/audit", async (req, res) => {
  try {
    const isAdmin = ["admin", "owner"].includes(req.user.role)
    const logs = await listAuditLogs({
      userId: isAdmin && req.query.userId ? req.query.userId : req.user._id,
      action: req.query.action,
      limit: Number(req.query.limit) || 100,
      admin: isAdmin && Boolean(req.query.userId),
    })
    // Non-admins only see their own
    if (!isAdmin) {
      const own = await listAuditLogs({ userId: req.user._id, limit: Number(req.query.limit) || 100 })
      return res.json({ logs: own })
    }
    res.json({ logs })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load audit logs" })
  }
})

router.get("/audit/all", restrictTo("admin", "owner"), async (req, res) => {
  try {
    const logs = await listAuditLogs({
      action: req.query.action,
      limit: Number(req.query.limit) || 200,
      admin: true,
    })
    res.json({ logs })
  } catch (err) {
    res.status(500).json({ message: "Failed to load audit logs" })
  }
})

export default router
