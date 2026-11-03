import mongoose from "mongoose"

const modelEntrySchema = new mongoose.Schema({
  name: String,
  id: String,
  description: String,
})

const adminSettingsSchema = new mongoose.Schema(
  {
    globalFeatureToggles: {
      strategyUploadStepByStep: { type: Boolean, default: true },
      video: { type: Boolean, default: true },
      hybrid: { type: Boolean, default: true },
      manual: { type: Boolean, default: true },
      newsFilter: { type: Boolean, default: true },
      riskAdjustment: { type: Boolean, default: false },
      profitLock50: { type: Boolean, default: false },
      sessionConstraints: { type: Boolean, default: true },
      preSignalValidation: { type: Boolean, default: false },
      aiChartAssist: { type: Boolean, default: true },
    },
    freeModels: {
      type: [modelEntrySchema],
      default: [
        { name: "Qwen3-VL 7B", id: "qwen/qwen3-vl-7b", description: "Best free chart analysis" },
        { name: "Gemma 4 26B", id: "google/gemma-4-26b", description: "Strong free vision" },
        {
          name: "Nemotron 3 Nano Omni Reasoning",
          id: "nvidia/nemotron-3-nano-omni",
          description: "Excellent free video + reasoning",
        },
      ],
    },
    paidModels: {
      type: [modelEntrySchema],
      default: [
        { name: "Claude 4 Opus", id: "anthropic/claude-4-opus", description: "Best discretionary logic" },
        { name: "Gemini 2.5 Pro", id: "google/gemini-2.5-pro", description: "Excellent long-context charts" },
        { name: "GPT-5.x class", id: "openai/gpt-5-x-class", description: "Strong price extraction" },
        { name: "Grok vision", id: "xai/grok-vision", description: "xAI vision model" },
        {
          name: "Nemotron 3.5 Super VL",
          id: "nvidia/nemotron-3.5-super-vl",
          description: "Excellent video understanding",
        },
      ],
    },
    /** Global default when user has no preference — free tier */
    defaultFreeModelId: { type: String, default: "qwen/qwen3-vl-7b" },
    /** Global default paid model when paid models enabled and user on paid path */
    defaultPaidModelId: { type: String, default: "anthropic/claude-4-opus" },
    marketDataProvider: {
      type: String,
      enum: ["twelvedata", "finnhub"],
      default: "twelvedata",
    },
    preSignalValidation: {
      mode: { type: String, enum: ["warn", "block"], default: "block" },
      runQuickBacktest: { type: Boolean, default: true },
      candleCount: { type: Number, default: 180 },
      timeframe: { type: String, default: "H1" },
      usePromotionGates: { type: Boolean, default: true },
      minTrades: { type: Number, default: 10 },
      minWinRate: { type: Number, default: 40 },
      minExpectancy: { type: Number, default: 0 },
      maxDrawdownPercent: { type: Number, default: 25 },
    },
    promotionGates: {
      enabled: { type: Boolean, default: false },
      minTrades: { type: Number, default: 20 },
      minWinRate: { type: Number, default: 45 },
      minExpectancy: { type: Number, default: 0 },
      maxDrawdownPercent: { type: Number, default: 20 },
      minProfitFactor: { type: Number, default: 1.1 },
      minDesignatedRRHitRate: { type: Number, default: 40 },
      minWalkForwardFoldPassRate: { type: Number, default: 50 },
      minStabilityScore: { type: Number, default: 40 },
    },
    newsDataProvider: {
      type: String,
      enum: ["financecalendar", "jbnews", "finnhub", "fmp"],
      default: "financecalendar",
    },
    modelSwitching: {
      freeModelsEnabled: { type: Boolean, default: true },
      paidModelsEnabled: { type: Boolean, default: false },
    },
    userBlockList: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        blocked: Boolean,
        reason: String,
        blockedAt: Date,
      },
    ],
    bestStrategiesLive: {
      demo: [{ type: mongoose.Schema.Types.ObjectId, ref: "Strategy" }],
      live: [{ type: mongoose.Schema.Types.ObjectId, ref: "Strategy" }],
      prop: [{ type: mongoose.Schema.Types.ObjectId, ref: "Strategy" }],
    },
    perUserModelUsage: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        modelPreference: String,
      },
    ],
  },
  { timestamps: true }
)

export default mongoose.model("AdminSettings", adminSettingsSchema)
