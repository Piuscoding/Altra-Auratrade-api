import { Router } from "express"
import { protect, loadUser, restrictTo } from "../middleware/auth.js"
import AdminSettings from "../models/AdminSettings.js"
import User from "../models/User.js"
import Strategy from "../models/Strategy.js"
import Trade from "../models/Trade.js"
import BrokerAccount from "../models/BrokerAccount.js"
import VisionJob from "../models/VisionJob.js"

const router = Router()
router.use(protect, loadUser, restrictTo("admin", "owner"))

async function getSettings() {
  let settings = await AdminSettings.findOne()
  if (!settings) settings = await AdminSettings.create({})
  return settings
}

router.get("/overview", async (_req, res) => {
  try {
    const [users, strategies, trades, brokers, visionJobs, blocked] = await Promise.all([
      User.countDocuments(),
      Strategy.countDocuments(),
      Trade.countDocuments(),
      BrokerAccount.countDocuments(),
      VisionJob.countDocuments(),
      User.countDocuments({ isBlocked: true }),
    ])
    const byStatus = await Strategy.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    res.json({
      counts: { users, strategies, trades, brokers, visionJobs, blocked },
      strategiesByStatus: byStatus,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load overview" })
  }
})

router.get("/settings", async (_req, res) => {
  try {
    const settings = await getSettings()
    res.json({ settings })
  } catch (err) {
    res.status(500).json({ message: "Failed to load settings" })
  }
})

router.patch("/settings/feature-toggles", async (req, res) => {
  try {
    const settings = await getSettings()
    const body = req.body || {}
    settings.globalFeatureToggles = {
      ...(settings.globalFeatureToggles?.toObject?.() || settings.globalFeatureToggles || {}),
      ...body,
    }
    await settings.save()
    res.json({
      globalFeatureToggles: settings.globalFeatureToggles,
      message: "Global feature toggles updated",
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update toggles" })
  }
})

router.patch("/settings/model-switching", async (req, res) => {
  try {
    const settings = await getSettings()
    settings.modelSwitching = {
      ...(settings.modelSwitching?.toObject?.() || settings.modelSwitching || {}),
      ...req.body,
    }
    await settings.save()
    res.json({ modelSwitching: settings.modelSwitching })
  } catch (err) {
    res.status(500).json({ message: "Failed to update model switching" })
  }
})

router.get("/users", async (req, res) => {
  try {
    const q = (req.query.q || "").trim()
    const filter = q
      ? {
          $or: [
            { email: new RegExp(q, "i") },
            { firstName: new RegExp(q, "i") },
            { lastName: new RegExp(q, "i") },
          ],
        }
      : {}
    const users = await User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .limit(100)
    res.json({ users })
  } catch (err) {
    res.status(500).json({ message: "Failed to list users" })
  }
})

router.post("/users/:id/block", async (req, res) => {
  try {
    const reason = (req.body?.reason || "").trim()
    if (!reason) {
      return res.status(400).json({ message: "Block reason is required" })
    }
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    if (user.role === "admin" || user.role === "owner") {
      return res.status(403).json({ message: "Cannot block admin or owner accounts" })
    }
    user.isBlocked = true
    await user.save()

    const settings = await getSettings()
    const existing = settings.userBlockList.find(
      (b) => String(b.userId) === String(user._id)
    )
    if (existing) {
      existing.blocked = true
      existing.reason = reason
      existing.blockedAt = new Date()
    } else {
      settings.userBlockList.push({
        userId: user._id,
        blocked: true,
        reason,
        blockedAt: new Date(),
      })
    }
    await settings.save()

    res.json({
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isBlocked: user.isBlocked,
      },
      reason,
      message: "User blocked",
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to block user" })
  }
})

router.post("/users/:id/unblock", async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    user.isBlocked = false
    await user.save()

    const settings = await getSettings()
    const existing = settings.userBlockList.find(
      (b) => String(b.userId) === String(user._id)
    )
    if (existing) {
      existing.blocked = false
      existing.reason = req.body?.reason || existing.reason || "Unblocked by admin"
      existing.blockedAt = new Date()
    }
    await settings.save()

    res.json({
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isBlocked: user.isBlocked,
      },
      message: "User unblocked",
    })
  } catch (err) {
    res.status(500).json({ message: "Failed to unblock user" })
  }
})

router.patch("/users/:id/model-preference", async (req, res) => {
  try {
    const { modelId } = req.body
    if (!modelId) return res.status(400).json({ message: "modelId required" })
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ message: "User not found" })
    user.modelPreference = modelId
    await user.save()

    const settings = await getSettings()
    const existing = settings.perUserModelUsage.find(
      (p) => String(p.userId) === String(user._id)
    )
    if (existing) existing.modelPreference = modelId
    else settings.perUserModelUsage.push({ userId: user._id, modelPreference: modelId })
    await settings.save()

    res.json({ message: "Per-user model preference updated", modelPreference: modelId })
  } catch (err) {
    res.status(500).json({ message: "Failed to set preference" })
  }
})

router.get("/strategies", async (req, res) => {
  try {
    const status = req.query.status
    const filter = status ? { status } : {}
    const strategies = await Strategy.find(filter)
      .populate("userId", "email firstName lastName")
      .sort({ updatedAt: -1 })
      .limit(100)
      .select("-steps.images.url -video.url -originalAssets")
    res.json({ strategies })
  } catch (err) {
    res.status(500).json({ message: "Failed to list strategies" })
  }
})

/** Admin-only permanent delete */
router.delete("/strategies/:id", async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id)
    if (!strategy) return res.status(404).json({ message: "Strategy not found" })

    await BrokerAccount.updateMany(
      { assignedStrategy: strategy._id },
      { $set: { assignedStrategy: null } }
    )
    await Strategy.deleteOne({ _id: strategy._id })
    res.json({ message: "Strategy permanently deleted by admin" })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to delete strategy" })
  }
})

router.get("/best-strategies", async (_req, res) => {
  try {
    const ranked = await Strategy.find({
      status: { $in: ["demo", "live", "approved"] },
      "performance.trades": { $gte: 0 },
    })
      .populate("userId", "email firstName lastName")
      .sort({
        "performance.expectancy": -1,
        "performance.profitFactor": -1,
        "performance.winRate": -1,
      })
      .limit(50)
      .select("name status performance userId sourceType overallConfidence type")

    const demo = ranked.filter((s) => s.status === "demo" || s.status === "approved")
    const live = ranked.filter((s) => s.status === "live")

    // Prop: strategies assigned to prop_firm broker accounts
    const propAccounts = await BrokerAccount.find({
      type: "prop_firm",
      assignedStrategy: { $ne: null },
    }).select("assignedStrategy")
    const propIds = propAccounts.map((a) => String(a.assignedStrategy))
    const prop = ranked.filter((s) => propIds.includes(String(s._id)))

    const settings = await getSettings()
    settings.bestStrategiesLive = {
      demo: demo.slice(0, 10).map((s) => s._id),
      live: live.slice(0, 10).map((s) => s._id),
      prop: prop.slice(0, 10).map((s) => s._id),
    }
    await settings.save()

    res.json({
      demo: demo.slice(0, 15),
      live: live.slice(0, 15),
      prop: prop.slice(0, 15),
      ranked: ranked.slice(0, 25),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load best strategies" })
  }
})

router.get("/public-feature-toggles", async (_req, res) => {
  try {
    const settings = await getSettings()
    res.json({
      globalFeatureToggles: settings.globalFeatureToggles,
      modelSwitching: settings.modelSwitching,
    })
  } catch (err) {
    res.status(500).json({ message: "Failed to load toggles" })
  }
})


router.patch("/settings/default-models", async (req, res) => {
  try {
    const settings = await getSettings()
    const { defaultFreeModelId, defaultPaidModelId } = req.body || {}
    if (defaultFreeModelId) {
      const ok = settings.freeModels?.some((m) => m.id === defaultFreeModelId)
      if (!ok) return res.status(400).json({ message: "defaultFreeModelId must be in free models list" })
      settings.defaultFreeModelId = defaultFreeModelId
    }
    if (defaultPaidModelId) {
      const ok = settings.paidModels?.some((m) => m.id === defaultPaidModelId)
      if (!ok) return res.status(400).json({ message: "defaultPaidModelId must be in paid models list" })
      settings.defaultPaidModelId = defaultPaidModelId
    }
    await settings.save()
    res.json({
      defaultFreeModelId: settings.defaultFreeModelId,
      defaultPaidModelId: settings.defaultPaidModelId,
      message: "Default models updated",
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update default models" })
  }
})


router.patch("/settings/data-providers", async (req, res) => {
  try {
    const settings = await getSettings()
    const { marketDataProvider, newsDataProvider } = req.body || {}
    if (marketDataProvider && ["twelvedata", "finnhub"].includes(marketDataProvider)) {
      settings.marketDataProvider = marketDataProvider
    }
    if (newsDataProvider && ["financecalendar", "jbnews", "finnhub", "fmp"].includes(newsDataProvider)) {
      settings.newsDataProvider = newsDataProvider
    }
    await settings.save()
    res.json({
      marketDataProvider: settings.marketDataProvider,
      newsDataProvider: settings.newsDataProvider,
      message: "Data providers updated",
    })
  } catch (err) {
    res.status(500).json({ message: "Failed to update data providers" })
  }
})


router.patch("/settings/pre-signal-validation", async (req, res) => {
  try {
    const settings = await getSettings()
    const body = req.body || {}
    if (typeof body.enabled === "boolean") {
      settings.globalFeatureToggles = {
        ...(settings.globalFeatureToggles?.toObject?.() || settings.globalFeatureToggles || {}),
        preSignalValidation: body.enabled,
      }
    }
    const cur = settings.preSignalValidation?.toObject?.() || settings.preSignalValidation || {}
    const next = { ...cur }
    for (const key of [
      "mode",
      "runQuickBacktest",
      "candleCount",
      "timeframe",
      "usePromotionGates",
      "minTrades",
      "minWinRate",
      "minExpectancy",
      "maxDrawdownPercent",
    ]) {
      if (body[key] !== undefined) next[key] = body[key]
    }
    settings.preSignalValidation = next
    await settings.save()
    res.json({
      enabled: settings.globalFeatureToggles?.preSignalValidation === true,
      preSignalValidation: settings.preSignalValidation,
      message: "Pre-signal validation settings saved",
    })
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to save" })
  }
})


router.patch("/settings/ai-chart-assist", async (req, res) => {
  try {
    const settings = await getSettings()
    const body = req.body || {}
    if (typeof body.enabled === "boolean") {
      settings.globalFeatureToggles = {
        ...(settings.globalFeatureToggles?.toObject?.() || settings.globalFeatureToggles || {}),
        aiChartAssist: body.enabled,
      }
    }
    const cur = settings.aiChartAssist?.toObject?.() || settings.aiChartAssist || {}
    const next = { ...cur }
    for (const key of ["cooldownSeconds", "cacheTtlSeconds", "maxPerHour", "candleCount"]) {
      if (body[key] !== undefined) next[key] = body[key]
    }
    settings.aiChartAssist = next
    await settings.save()
    res.json({
      enabled: settings.globalFeatureToggles?.aiChartAssist !== false,
      aiChartAssist: settings.aiChartAssist,
      message: "AI chart assist settings saved",
    })
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to save" })
  }
})

export default router
