import mongoose from "mongoose"

const strategyStepSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  explanation: { type: String, default: "" },
  images: [{ url: String, annotations: [String] }],
  aiInterpretation: String,
  confidence: Number,
  userCorrections: String,
})

const metricsBucketSchema = new mongoose.Schema(
  {
    winRate: { type: Number, default: 0 },
    expectancy: { type: Number, default: 0 },
    profitFactor: { type: Number, default: 0 },
    maxDD: { type: Number, default: 0 },
    trades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    /** Average realized R multiple on closed trades (risk units) */
    avgRealizedRR: { type: Number, default: 0 },
    /** Median realized R multiple */
    medianRealizedRR: { type: Number, default: 0 },
    /** % of wins that reached at least designated RR */
    designatedRRHitRate: { type: Number, default: 0 },
    /** Most common / high-probability RR band (rounded) */
    highProbabilityRR: { type: Number, default: 0 },
    lastUpdatedAt: { type: Date, default: null },
  },
  { _id: false }
)

const strategySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    version: { type: Number, default: 1 },
    sourceType: {
      type: String,
      enum: ["visual_steps", "video", "hybrid", "manual"],
      default: "visual_steps",
    },
    status: {
      type: String,
      enum: ["draft", "review", "approved", "demo", "live", "disabled", "archived"],
      default: "draft",
    },
    overallConfidence: { type: Number, default: 0 },
    steps: [strategyStepSchema],
    video: {
      url: String,
      transcript: String,
      keyFrames: [String],
      aiSummary: String,
    },
    rules: { type: mongoose.Schema.Types.Mixed, default: {} },
    plottedLevels: { type: mongoose.Schema.Types.Mixed, default: {} },
    originalAssets: {
      images: [String],
      videoUrl: String,
    },
    /** User/designated targets */
    designatedRR: { type: Number, default: 2 },
    targetWinRate: { type: Number, default: 50 },
    /**
     * Which RR auto-signal (future) / sizing helpers should prefer.
     * designated = use designatedRR; empirical = use highProbabilityRR from best available data
     */
    rrMode: {
      type: String,
      enum: ["designated", "empirical"],
      default: "designated",
    },
    /** Legacy flat performance (kept in sync with metrics.backtest for compatibility) */
    performance: {
      winRate: { type: Number, default: 0 },
      expectancy: { type: Number, default: 0 },
      profitFactor: { type: Number, default: 0 },
      maxDD: { type: Number, default: 0 },
      trades: { type: Number, default: 0 },
    },
    metrics: {
      backtest: { type: metricsBucketSchema, default: () => ({}) },
      demo: { type: metricsBucketSchema, default: () => ({}) },
    },
    allowedPairs: [String],
    autoSignal: {
      enabled: { type: Boolean, default: false },
      intervalMinutes: { type: Number, default: 15 },
      timeframe: { type: String, default: "H1" },
      pairs: { type: [String], default: ["EURUSD"] },
      maxSignalsPerDay: { type: Number, default: 5 },
      lastRunAt: { type: Date, default: null },
      lastSignalAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      lastResult: { type: String, default: null },
      lastStage: { type: String, default: null },
      nextRunAt: { type: Date, default: null },
      healthStatus: {
        type: String,
        enum: ["idle", "ok", "skipped", "error", "disabled", "no_account"],
        default: "idle",
      },
      requireAssignedAccount: { type: Boolean, default: true },
      minSignalGapMinutes: { type: Number, default: 30 },
    },
    accountConfigId: { type: mongoose.Schema.Types.ObjectId, ref: "AccountConfig" },
    riskAdjustment: {
      enabled: { type: Boolean, default: false },
      trendAlignment: { type: Boolean, default: false },
      newsImpactCheck: { type: Boolean, default: false },
      profitLock50: {
        enabled: { type: Boolean, default: false },
        activationLevel: { type: Number, default: 50 },
      },
      drawdownGuard: { type: Boolean, default: true },
      capitalGuard: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
)

export default mongoose.model("Strategy", strategySchema)
