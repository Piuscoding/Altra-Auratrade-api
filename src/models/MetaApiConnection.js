import mongoose from "mongoose"

const metaApiConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    brokerAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BrokerAccount",
      required: true,
    },
    login: { type: String, required: true },
    server: { type: String, required: true },
    platform: { type: String, enum: ["mt4", "mt5"], default: "mt5" },
    /** MetaApi cloud account id when provisioned */
    metaApiAccountId: { type: String, default: null },
    /** Never returned to client in full — stored for reconnect */
    passwordEnc: { type: String, default: null },
    region: { type: String, default: "new-york" },
    state: {
      type: String,
      enum: ["pending", "deploying", "deployed", "undeployed", "failed"],
      default: "pending",
    },
    lastError: { type: String, default: null },
    lastConnectedAt: Date,
  },
  { timestamps: true }
)

export default mongoose.model("MetaApiConnection", metaApiConnectionSchema)
