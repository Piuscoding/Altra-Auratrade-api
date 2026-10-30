import nodemailer from "nodemailer"

/**
 * Zoho SMTP mailer for Altra-AuraTrade.
 * Configure ZOHO_SMTP_* and ZOHO_FROM_* in .env
 */
function createTransporter() {
  const host = process.env.ZOHO_SMTP_HOST || "smtp.zoho.com"
  const port = Number(process.env.ZOHO_SMTP_PORT || 465)
  const user = process.env.ZOHO_SMTP_USER
  const pass = process.env.ZOHO_SMTP_PASS

  if (!user || !pass) {
    console.warn("[email] ZOHO_SMTP_USER or ZOHO_SMTP_PASS missing — emails will be logged to console only")
    return null
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  })
}

export async function sendEmail({ to, subject, html, text }) {
  const fromEmail = process.env.ZOHO_FROM_EMAIL || process.env.ZOHO_SMTP_USER
  const fromName = process.env.ZOHO_FROM_NAME || "Altra-AuraTrade"
  const transporter = createTransporter()

  if (!transporter) {
    console.log("[email:dev] To:", to)
    console.log("[email:dev] Subject:", subject)
    console.log("[email:dev] Body:", text || html)
    return { success: true, mode: "log-only" }
  }

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html,
  })

  return { success: true, messageId: info.messageId }
}

export async function sendPasswordResetEmail(to, resetToken) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173"
  const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`

  const subject = "Reset your Altra-AuraTrade password"
  const text = `You requested a password reset.\n\nOpen this link to set a new password (valid 1 hour):\n${resetLink}\n\nIf you did not request this, ignore this email.\n\n— Altra-AuraTrade`
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0a0e1a; color: #e2e8f0; padding: 32px; border-radius: 12px;">
      <h2 style="color: #ffd700; margin-top: 0;">Altra-AuraTrade</h2>
      <p>You requested a password reset.</p>
      <p style="margin: 24px 0;">
        <a href="${resetLink}" style="display: inline-block; background: linear-gradient(90deg, #ffd700, #f59e0b); color: #0a0e1a; font-weight: 700; padding: 12px 24px; border-radius: 8px; text-decoration: none;">
          Reset Password
        </a>
      </p>
      <p style="font-size: 13px; color: #94a3b8;">This link expires in 1 hour. If you did not request a reset, you can ignore this email.</p>
      <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Trade with Intelligence</p>
    </div>
  `

  return sendEmail({ to, subject, html, text })
}
