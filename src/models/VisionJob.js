import mongoose from "mongoose"

const visionJobSchema = new mongoose.Schema(
  {
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed"],
      default: "queued",
    },
    inputType: {
      type: String,
      enum: ["visual_steps", "video", "hybrid", "manual"],
      default: "visual_steps",
    },
    modelId: { type: String, required: true },
    modelName: { type: String, default: "" },
    rawOutputs: { type: mongoose.Schema.Types.Mixed, default: {} },
    structuredResult: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidenceBreakdown: {
      base: { type: Number, default: 0 },
      penalties: { type: Number, default: 0 },
      bonuses: { type: Number, default: 0 },
      final: { type: Number, default: 0 },
      reasons: [String],
    },
    overallConfidence: { type: Number, default: 0 },
    errorMessage: { type: String, default: null },
    cached: { type: Boolean, default: false },
    completedAt: Date,
  },
  { timestamps: true }
)

visionJobSchema.index({ strategyId: 1, createdAt: -1 })

export default mongoose.model("VisionJob", visionJobSchema)
