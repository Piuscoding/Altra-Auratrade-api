import mongoose from "mongoose"

const chartDrawingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    pair: { type: String, required: true },
    timeframe: { type: String, required: true },
    drawings: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
)

chartDrawingSchema.index({ userId: 1, pair: 1, timeframe: 1 }, { unique: true })

export default mongoose.model("ChartDrawing", chartDrawingSchema)
