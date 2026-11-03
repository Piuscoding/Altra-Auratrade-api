import mongoose from "mongoose"
import bcrypt from "bcryptjs"

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    role: { type: String, enum: ["user", "admin", "owner"], default: "user" },
    isBlocked: { type: Boolean, default: false },
    blockReason: { type: String, default: null },
    modelPreference: { type: String, default: "qwen/qwen3-vl-7b" },
    preferences: {
      aiChartAssist: {
        enabled: { type: Boolean, default: true },
        cooldownSeconds: { type: Number, default: 120 },
        modelId: { type: String, default: null },
      },
      preSignalValidation: {
        enabled: { type: Boolean, default: false },
        mode: { type: String, enum: ["warn", "block"], default: "warn" },
        runQuickBacktest: { type: Boolean, default: true },
        candleCount: { type: Number, default: 180 },
        timeframe: { type: String, default: "H1" },
        minTrades: { type: Number, default: 10 },
        minWinRate: { type: Number, default: 40 },
        minExpectancy: { type: Number, default: 0 },
        maxDrawdownPercent: { type: Number, default: 25 },
      },
    },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
)

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next()
  this.password = await bcrypt.hash(this.password, 12)
  next()
})

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password)
}

export default mongoose.model("User", userSchema)
