import mongoose from "mongoose"

const notificationPreferenceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    telegram: { type: Boolean, default: false },
    discord: { type: Boolean, default: false },
    telegramChatId: { type: String, default: "" },
    discordWebhookUrl: { type: String, default: "" },
    events: {
      signal: { type: Boolean, default: true },
      trade_open: { type: Boolean, default: true },
      trade_close: { type: Boolean, default: true },
      trade_rejected: { type: Boolean, default: true },
      news: { type: Boolean, default: true },
      sl_adjust: { type: Boolean, default: true },
      profit_lock: { type: Boolean, default: true },
      system: { type: Boolean, default: true },
      security: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
)

export default mongoose.model("NotificationPreference", notificationPreferenceSchema)
