import mongoose from "mongoose"

const strategyStepSchema = new mongoose.Schema({
  order: { type: Number, required: true },
  explanation: { type: String, default: "" },
  images: [{ url: String, annotations: [String] }],
  aiInterpretation: String,
  confidence: Number,
  userCorrections: String,
})

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
    performance: {
      winRate: { type: Number, default: 0 },
      expectancy: { type: Number, default: 0 },
      profitFactor: { type: Number, default: 0 },
      maxDD: { type: Number, default: 0 },
      trades: { type: Number, default: 0 },
    },
    allowedPairs: [String],
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
