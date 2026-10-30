import mongoose from "mongoose"

const brokerAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["demo", "live", "prop_firm"], default: "demo" },
    provider: { type: String, enum: ["metaapi", "oanda", "ibkr", "others"], default: "metaapi" },
    credentials: {
      encrypted: { type: Boolean, default: true },
      vaultId: String,
      /** Public-safe connection labels only */
      loginHint: String,
      serverHint: String,
      accountIdHint: String,
    },
    metaApiConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaApiConnection",
      default: null,
    },
    status: {
      type: String,
      enum: ["connected", "testing", "live", "disconnected"],
      default: "disconnected",
    },
    balance: { type: Number, default: 0 },
    equity: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    lastSync: Date,
    assignedStrategy: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", default: null },
    assignmentHistory: [
      {
        strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy" },
        assignedAt: { type: Date, default: Date.now },
        unassignedAt: Date,
      },
    ],
    propFirmLimits: {
      maxDailyDD: { type: Number, default: 5 },
      maxWeeklyDD: { type: Number, default: 10 },
      maxOpenRisk: { type: Number, default: 2 },
      maxConsecutiveLosses: { type: Number, default: 3 },
      dailyLossCap: { type: Number, default: 3 },
      weeklyLossCap: { type: Number, default: 6 },
    },
    isNewsFilterEnabled: { type: Boolean, default: true },
    newsFilters: {
      type: [String],
      default: ["FOMC", "CPI", "NFP", "GDP", "ECB", "BOE"],
    },
    newsFilterCustom: { type: [String], default: [] },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
)

brokerAccountSchema.index({ userId: 1 })
brokerAccountSchema.index(
  { assignedStrategy: 1 },
  {
    unique: true,
    partialFilterExpression: { assignedStrategy: { $type: "objectId" } },
  }
)

export default mongoose.model("BrokerAccount", brokerAccountSchema)
