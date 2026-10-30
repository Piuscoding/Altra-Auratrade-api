import mongoose from "mongoose"

const tradeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    brokerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "BrokerAccount", default: null },
    signalId: { type: String, default: null },
    pair: { type: String, required: true },
    direction: { type: String, enum: ["long", "short"], required: true },
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    originalSL: { type: Number, default: null },
    lotSize: { type: Number, default: 0 },
    riskPercent: { type: Number, default: 1 },
    status: {
      type: String,
      enum: [
        "signal_only",
        "pending",
        "open",
        "closed",
        "cancelled",
        "rejected",
        "skipped_due_to_news",
        "skipped_session",
        "skipped_risk",
      ],
      default: "pending",
    },
    session: { type: String, default: null },
    accountType: { type: String, enum: ["demo", "live", "prop_firm", null], default: null },
    propLimitsApplied: { type: Boolean, default: false },
    provider: { type: String, default: null },
    executionMethod: { type: String, enum: ["metaapi", "direct_api", "paper", null], default: "paper" },
    skippedDueToNews: { type: Boolean, default: false },
    newsEvent: { type: String, default: null },
    newsEventTime: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    pnl: { type: Number, default: 0 },
    closedAt: { type: Date, default: null },
    slAdjustment: {
      applied: { type: Boolean, default: false },
      originalSL: { type: Number, default: null },
      newSL: { type: Number, default: null },
      adjustmentReason: {
        type: String,
        enum: ["trend_lock", "profit_lock", null],
        default: null,
      },
      newsImpactEstimated: { type: Number, default: null },
      singleAdjustment: { type: Boolean, default: true },
    },
    profitLockActivated: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
)

tradeSchema.index({ userId: 1, createdAt: -1 })
tradeSchema.index({ strategyId: 1, status: 1 })

export default mongoose.model("Trade", tradeSchema)
