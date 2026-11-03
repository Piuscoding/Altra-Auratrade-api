import mongoose from "mongoose"

const performanceSnapshotSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    source: {
      type: String,
      enum: ["backtest_historical", "backtest_walk_forward", "demo_live", "manual"],
      required: true,
    },
    backtestRunId: { type: mongoose.Schema.Types.ObjectId, ref: "BacktestRun", default: null },
    pair: String,
    timeframe: String,
    metrics: {
      winRate: Number,
      expectancy: Number,
      profitFactor: Number,
      maxDD: Number,
      trades: Number,
      avgRealizedRR: Number,
      designatedRRHitRate: Number,
      highProbabilityRR: Number,
      stabilityScore: Number,
      foldPassRate: Number,
    },
    promotion: {
      passed: { type: Boolean, default: false },
      gates: { type: mongoose.Schema.Types.Mixed, default: {} },
      failures: { type: [String], default: [] },
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
)

performanceSnapshotSchema.index({ strategyId: 1, createdAt: -1 })
performanceSnapshotSchema.index({ userId: 1, createdAt: -1 })

export default mongoose.model("PerformanceSnapshot", performanceSnapshotSchema)
