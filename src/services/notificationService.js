import Notification from "../models/Notification.js"
import NotificationPreference from "../models/NotificationPreference.js"
import User from "../models/User.js"
import { sendEmail } from "../utils/email.js"
import { writeAudit } from "./auditService.js"

export async function getOrCreatePrefs(userId) {
  let prefs = await NotificationPreference.findOne({ userId })
  if (!prefs) {
    prefs = await NotificationPreference.create({ userId })
  }
  return prefs
}

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId) return { status: "skipped" }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    })
    if (!res.ok) {
      const t = await res.text()
      console.error("[telegram]", res.status, t.slice(0, 200))
      return { status: "failed" }
    }
    return { status: "sent" }
  } catch (err) {
    console.error("[telegram]", err.message)
    return { status: "failed" }
  }
}

async function sendDiscord(webhookUrl, title, body, severity) {
  if (!webhookUrl) return { status: "skipped" }
  const colors = {
    info: 5793266,
    success: 5763719,
    warning: 16705372,
    critical: 15548997,
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description: body,
            color: colors[severity] || colors.info,
            footer: { text: "Altra-AuraTrade" },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    })
    if (!res.ok) {
      console.error("[discord]", res.status)
      return { status: "failed" }
    }
    return { status: "sent" }
  } catch (err) {
    console.error("[discord]", err.message)
    return { status: "failed" }
  }
}

/**
 * Create in-app notification and fan-out to enabled channels.
 */
export async function notifyUser(userId, {
  type = "system",
  title,
  body,
  severity = "info",
  meta = {},
}) {
  const prefs = await getOrCreatePrefs(userId)
  const eventAllowed = prefs.events?.[type] !== false

  if (!eventAllowed) {
    return null
  }

  const channels = {
    inApp: prefs.inApp !== false,
    email: Boolean(prefs.email),
    telegram: Boolean(prefs.telegram && prefs.telegramChatId),
    discord: Boolean(prefs.discord && prefs.discordWebhookUrl),
  }

  const delivery = {
    email: "skipped",
    telegram: "skipped",
    discord: "skipped",
  }

  const notification = await Notification.create({
    userId,
    type,
    title,
    body,
    severity,
    read: false,
    channels,
    delivery,
    meta,
  })

  const user = await User.findById(userId)
  const text = `Altra-AuraTrade\n${title}\n${body}`

  if (channels.email && user?.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: `[Altra-AuraTrade] ${title}`,
        text,
        html: `<div style="font-family:Inter,Arial,sans-serif;background:#0a0e1a;color:#e2e8f0;padding:20px;border-radius:10px">
          <h3 style="color:#ffd700;margin:0 0 8px">${title}</h3>
          <p style="margin:0;white-space:pre-wrap">${body}</p>
          <p style="margin-top:16px;font-size:12px;color:#64748b">Trade with Intelligence</p>
        </div>`,
      })
      delivery.email = "sent"
    } catch (err) {
      console.error("[notify email]", err.message)
      delivery.email = "failed"
    }
  }

  if (channels.telegram) {
    const r = await sendTelegram(prefs.telegramChatId, text)
    delivery.telegram = r.status
  }

  if (channels.discord) {
    const r = await sendDiscord(prefs.discordWebhookUrl, title, body, severity)
    delivery.discord = r.status
  }

  notification.delivery = delivery
  await notification.save()

  await writeAudit({
    userId,
    action: "notification.sent",
    resource: "Notification",
    resourceId: notification._id,
    summary: title,
    details: { type, severity, delivery },
  })

  return notification
}

export async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  const q = { userId }
  if (unreadOnly) q.read = false
  return Notification.find(q).sort({ createdAt: -1 }).limit(limit)
}

export async function markRead(userId, id) {
  return Notification.findOneAndUpdate(
    { _id: id, userId },
    { $set: { read: true } },
    { new: true }
  )
}

export async function markAllRead(userId) {
  await Notification.updateMany({ userId, read: false }, { $set: { read: true } })
  return { ok: true }
}

export async function unreadCount(userId) {
  return Notification.countDocuments({ userId, read: false })
}
