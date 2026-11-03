import mongoose from "mongoose"

const backtestRunSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
    pair: { type: String, required: true },
    timeframe: { type: String, default: "H1" },
    mode: {
      type: String,
      enum: ["historical", "walk_forward"],
      default: "historical",
    },
    params: {
      riskPerTradePercent: { type: Number, default: 1 },
      initialBalance: { type: Number, default: 10000 },
      trainBars: { type: Number, default: 0 },
      testBars: { type: Number, default: 0 },
      candleCount: { type: Number, default: 500 },
    },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed"],
      default: "queued",
    },
    results: {
      trades: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      winRate: { type: Number, default: 0 },
      expectancy: { type: Number, default: 0 },
      profitFactor: { type: Number, default: 0 },
      maxDrawdownPercent: { type: Number, default: 0 },
      netProfit: { type: Number, default: 0 },
      finalBalance: { type: Number, default: 0 },
      equityCurve: [{ bar: Number, equity: Number }],
      tradeList: [
        {
          bar: Number,
          direction: String,
          entry: Number,
          exit: Number,
          pnl: Number,
          reason: String,
        },
      ],
      walkForwardFolds: [
        {
          fold: Number,
          trainBars: Number,
          testBars: Number,
          trades: Number,
          winRate: Number,
          netProfit: Number,
          maxDrawdownPercent: Number,
        },
      ],
    },
    errorMessage: { type: String, default: null },
    completedAt: Date,
  },
  { timestamps: true }
)

backtestRunSchema.index({ userId: 1, createdAt: -1 })

export default mongoose.model("BacktestRun", backtestRunSchema)
