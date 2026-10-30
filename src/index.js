import express from "express"
import cors from "cors"
import helmet from "helmet"
import morgan from "morgan"
import rateLimit from "express-rate-limit"
import dotenv from "dotenv"
import multer from "multer"
import { connectDB } from "./config/db.js"
import authRoutes from "./routes/auth.js"
import strategyRoutes from "./routes/strategies.js"
import visionRoutes from "./routes/vision.js"
import tradingRoutes from "./routes/trading.js"
import accountConfigRoutes from "./routes/accountConfig.js"
import brokerRoutes from "./routes/brokers.js"
import chartRoutes from "./routes/charts.js"
import adminRoutes from "./routes/admin.js"
import notificationRoutes from "./routes/notifications.js"

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }))
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
)
app.use(express.json({ limit: "60mb" }))
app.use(express.urlencoded({ extended: true, limit: "60mb" }))
app.use(morgan("dev"))

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use("/api", limiter)

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Altra-AuraTrade API",
    version: "1.9.0",
    phase: 9,
    openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
    metaApiConfigured: Boolean(process.env.METAAPI_TOKEN),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  })
})

app.use("/api/auth", authRoutes)
app.use("/api/strategies", strategyRoutes)
app.use("/api/vision", visionRoutes)
app.use("/api/trading", tradingRoutes)
app.use("/api/account-config", accountConfigRoutes)
app.use("/api/brokers", brokerRoutes)
app.use("/api/charts", chartRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/notifications", notificationRoutes)

app.use((err, _req, res, _next) => {
  console.error(err.stack || err)
  if (err instanceof multer.MulterError || (err.message && err.message.includes("Only image"))) {
    return res.status(400).json({ message: err.message })
  }
  res.status(err.status || 500).json({ message: err.message || "Internal server error" })
})

async function start() {
  try {
    await connectDB()
    app.listen(PORT, () => {
      console.log(`Altra-AuraTrade API running on http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error("Failed to start server:", err)
    process.exit(1)
  }
}

start()
