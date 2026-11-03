import mongoose from "mongoose"

const propChallengeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    brokerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BrokerAccount",
      required: true,
    },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", default: null },
    name: { type: String, default: "Prop Challenge" },
    firmName: { type: String, default: "" },
    phase: {
      type: String,
      enum: ["challenge", "verification", "funded", "failed", "passed"],
      default: "challenge",
    },
    startingBalance: { type: Number, required: true },
    currentBalance: { type: Number, required: true },
    highWaterMark: { type: Number, required: true },
    rules: {
      maxDailyDDPercent: { type: Number, default: 5 },
      maxOverallDDPercent: { type: Number, default: 10 },
      profitTargetPercent: { type: Number, default: 8 },
      maxOpenRiskPercent: { type: Number, default: 2 },
      maxConsecutiveLosses: { type: Number, default: 3 },
      maxTradesPerDay: { type: Number, default: 10 },
      /** Consistency: no single day may exceed this % of total profit */
      maxDayProfitSharePercent: { type: Number, default: 40 },
      minTradingDays: { type: Number, default: 5 },
    },
    stats: {
      dayStartEquity: { type: Number, default: null },
      dayStartDate: { type: String, default: null },
      weekStartEquity: { type: Number, default: null },
      weekStartKey: { type: String, default: null },
      dailyPnL: { type: Number, default: 0 },
      weeklyPnL: { type: Number, default: 0 },
      overallPnL: { type: Number, default: 0 },
      dailyDDPercent: { type: Number, default: 0 },
      overallDDPercent: { type: Number, default: 0 },
      consecutiveLosses: { type: Number, default: 0 },
      tradesToday: { type: Number, default: 0 },
      tradingDays: { type: Number, default: 0 },
      bestDayProfit: { type: Number, default: 0 },
      consistencyScore: { type: Number, default: 100 },
      profitTargetProgressPercent: { type: Number, default: 0 },
    },
    status: {
      type: String,
      enum: ["active", "breached", "completed", "paused"],
      default: "active",
    },
    breachReason: { type: String, default: null },
    breachedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
    timezone: { type: String, default: "UTC" },
    failReasons: [
      {
        at: { type: Date, default: Date.now },
        reason: String,
        phase: String,
        metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
      },
    ],
    equityCurve: [
      {
        at: { type: Date, default: Date.now },
        equity: Number,
        dailyDDPercent: Number,
        overallDDPercent: Number,
        phase: String,
      },
    ],
    pausedAt: { type: Date, default: null },
    pauseReason: { type: String, default: null },
    resumedAt: { type: Date, default: null },
  },
  { timestamps: true }
)

propChallengeSchema.index({ userId: 1, status: 1 })
propChallengeSchema.index({ brokerAccountId: 1 })

export default mongoose.model("PropChallenge", propChallengeSchema)
