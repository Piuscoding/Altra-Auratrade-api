import mongoose from "mongoose"

const signalSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    pair: { type: String, required: true },
    direction: { type: String, enum: ["long", "short"], required: true },
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    timeframe: { type: String, default: "M15" },
    confidence: { type: Number, default: 0 },
    session: { type: String, default: null },
    status: {
      type: String,
      enum: ["generated", "validated", "rejected", "executed", "signal_only", "expired"],
      default: "generated",
    },
    rejectReason: { type: String, default: null },
    riskChecks: { type: mongoose.Schema.Types.Mixed, default: {} },
    sessionChecks: { type: mongoose.Schema.Types.Mixed, default: {} },
    newsChecks: { type: mongoose.Schema.Types.Mixed, default: {} },
    onlySignals: { type: Boolean, default: false },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: "Trade", default: null },
  },
  { timestamps: true }
)

signalSchema.index({ userId: 1, createdAt: -1 })

export default mongoose.model("Signal", signalSchema)
