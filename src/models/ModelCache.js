import mongoose from "mongoose"

const modelCacheSchema = new mongoose.Schema(
  {
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    modelId: { type: String, required: true },
    cacheKey: { type: String, required: true, unique: true },
    cachedResult: { type: mongoose.Schema.Types.Mixed, required: true },
    ttlSeconds: { type: Number, default: 86400 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
)

modelCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model("ModelCache", modelCacheSchema)
