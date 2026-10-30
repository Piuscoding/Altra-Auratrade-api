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
