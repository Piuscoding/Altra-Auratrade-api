import mongoose from "mongoose"

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "signal",
        "trade_open",
        "trade_close",
        "trade_rejected",
        "news",
        "sl_adjust",
        "profit_lock",
        "system",
        "security",
      ],
      default: "system",
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    severity: {
      type: String,
      enum: ["info", "success", "warning", "critical"],
      default: "info",
    },
    read: { type: Boolean, default: false },
    channels: {
      inApp: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
      telegram: { type: Boolean, default: false },
      discord: { type: Boolean, default: false },
    },
    delivery: {
      email: { type: String, enum: ["pending", "sent", "skipped", "failed"], default: "skipped" },
      telegram: { type: String, enum: ["pending", "sent", "skipped", "failed"], default: "skipped" },
      discord: { type: String, enum: ["pending", "sent", "skipped", "failed"], default: "skipped" },
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
)

notificationSchema.index({ userId: 1, createdAt: -1 })
notificationSchema.index({ userId: 1, read: 1 })

export default mongoose.model("Notification", notificationSchema)
