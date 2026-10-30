import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import AccountConfig from "../models/AccountConfig.js"
import Strategy from "../models/Strategy.js"
import { getOrCreateAccountConfig, getCurrentForexSession } from "../services/sessionAccountEngine.js"

const router = Router()
router.use(protect, loadUser)

router.get("/sessions/current", (_req, res) => {
  const sessions = getCurrentForexSession()
  res.json({
    sessions,
    isOpen: sessions.length > 0,
  })
})

router.get("/", async (req, res) => {
  try {
    const configs = await AccountConfig.find({ userId: req.user._id }).sort({ updatedAt: -1 })
    res.json({ configs })
  } catch (err) {
    res.status(500).json({ message: "Failed to list configs" })
  }
})

router.get("/strategy/:strategyId", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.strategyId,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    const config = await getOrCreateAccountConfig(req.user._id, strategy._id)
    res.json({ config })
  } catch (err) {
    res.status(500).json({ message: "Failed to load config" })
  }
})

router.put("/strategy/:strategyId", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.strategyId,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }

    let config = await getOrCreateAccountConfig(req.user._id, strategy._id)
    const body = req.body || {}

    if (body.type) config.type = body.type
    if (Array.isArray(body.sessions)) config.sessions = body.sessions
    if (body.tradeFrequency && typeof body.tradeFrequency === "object") {
      config.tradeFrequency = { ...config.tradeFrequency.toObject?.() || config.tradeFrequency, ...body.tradeFrequency }
    }
    if (body.maxTradesPerWeek !== undefined) {
      config.maxTradesPerWeek =
        body.maxTradesPerWeek === null || body.maxTradesPerWeek === ""
          ? null
          : Number(body.maxTradesPerWeek)
    }
    if (typeof body.oneSignalPerSession === "boolean") {
      config.oneSignalPerSession = body.oneSignalPerSession
    }
    if (typeof body.allowMultipleSessions === "boolean") {
      config.allowMultipleSessions = body.allowMultipleSessions
    }
    if (body.tradeDirection) config.tradeDirection = body.tradeDirection
    if (Array.isArray(body.allowedPairs)) config.allowedPairs = body.allowedPairs
    if (typeof body.onlySignals === "boolean") config.onlySignals = body.onlySignals
    if (body.propFirmLimits && typeof body.propFirmLimits === "object") {
      config.propFirmLimits = {
        ...config.propFirmLimits.toObject?.() || config.propFirmLimits,
        ...body.propFirmLimits,
      }
    }

    await config.save()
    if (!strategy.accountConfigId) {
      strategy.accountConfigId = config._id
      await strategy.save()
    }
    res.json({ config })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update config" })
  }
})

router.patch("/strategy/:strategyId/risk-adjustment", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.strategyId,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    const body = req.body || {}
    strategy.riskAdjustment = {
      enabled: Boolean(body.enabled),
      trendAlignment: Boolean(body.trendAlignment),
      newsImpactCheck: Boolean(body.newsImpactCheck),
      profitLock50: {
        enabled: Boolean(body.profitLock50?.enabled),
        activationLevel: Number(body.profitLock50?.activationLevel) || 50,
      },
      drawdownGuard: body.drawdownGuard !== false,
      capitalGuard: body.capitalGuard !== false,
    }
    await strategy.save()
    res.json({
      riskAdjustment: strategy.riskAdjustment,
      message: strategy.riskAdjustment.enabled
        ? "Risk adjustment enabled — use with news filter OFF"
        : "Risk adjustment remains OFF (safe default)",
    })
  } catch (err) {
    res.status(500).json({ message: "Failed to update risk adjustment" })
  }
})

export default router
