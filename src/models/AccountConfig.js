import mongoose from "mongoose"

const accountConfigSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy" },
    type: { type: String, enum: ["demo", "live", "prop_firm"], default: "demo" },
    sessions: {
      type: [String],
      enum: ["london", "newyork", "tokyo", "sydney"],
      default: ["london", "newyork", "tokyo", "sydney"],
    },
    tradeFrequency: {
      monday: { type: Boolean, default: true },
      tuesday: { type: Boolean, default: true },
      wednesday: { type: Boolean, default: true },
      thursday: { type: Boolean, default: true },
      friday: { type: Boolean, default: true },
      saturday: { type: Boolean, default: false },
      sunday: { type: Boolean, default: false },
    },
    maxTradesPerWeek: { type: Number, default: null },
    oneSignalPerSession: { type: Boolean, default: true },
    allowMultipleSessions: { type: Boolean, default: true },
    tradeDirection: {
      type: String,
      enum: ["long", "short", "long_short"],
      default: "long_short",
    },
    allowedPairs: { type: [String], default: [] },
    onlySignals: { type: Boolean, default: false },
    propFirmLimits: {
      maxDailyDD: { type: Number, default: 5 },
      maxWeeklyDD: { type: Number, default: 10 },
      maxOpenRisk: { type: Number, default: 2 },
      maxConsecutiveLosses: { type: Number, default: 3 },
      dailyLossCap: { type: Number, default: 3 },
      weeklyLossCap: { type: Number, default: 6 },
    },
  },
  { timestamps: true }
)

export default mongoose.model("AccountConfig", accountConfigSchema)
