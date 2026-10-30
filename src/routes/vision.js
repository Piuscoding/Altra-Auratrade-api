import { Router } from "express"
import { protect, loadUser, restrictTo } from "../middleware/auth.js"
import {
  runVisionAnalysis,
  getLatestVisionJob,
  applyUserCorrections,
} from "../services/visionPipeline.js"
import VisionJob from "../models/VisionJob.js"
import AdminSettings from "../models/AdminSettings.js"
import User from "../models/User.js"

const router = Router()

router.use(protect, loadUser)

router.post("/analyze/:strategyId", async (req, res) => {
  try {
    const force = Boolean(req.body?.force)
    const result = await runVisionAnalysis(req.params.strategyId, req.user._id, { force })
    res.json({
      message: result.cached
        ? "Returned cached vision analysis"
        : result.offline
          ? "Offline analysis (set OPENROUTER_API_KEY for live vision)"
          : "Vision analysis completed",
      job: result.job,
      strategy: result.strategy,
      cached: result.cached,
      offline: result.offline || false,
    })
  } catch (err) {
    console.error(err)
    res.status(err.status || 500).json({ message: err.message || "Vision analysis failed" })
  }
})

router.get("/jobs/:strategyId", async (req, res) => {
  try {
    const job = await getLatestVisionJob(req.params.strategyId, req.user._id)
    if (!job) {
      return res.status(404).json({ message: "No vision job found for this strategy" })
    }
    res.json({ job })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load vision job" })
  }
})

router.get("/jobs/:strategyId/history", async (req, res) => {
  try {
    const jobs = await VisionJob.find({
      strategyId: req.params.strategyId,
      userId: req.user._id,
    })
      .sort({ createdAt: -1 })
      .limit(20)
    res.json({ jobs })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load job history" })
  }
})

router.post("/review/:strategyId", async (req, res) => {
  try {
    const strategy = await applyUserCorrections(req.params.strategyId, req.user._id, req.body)
    res.json({ strategy, message: "Corrections saved" })
  } catch (err) {
    console.error(err)
    res.status(err.status || 500).json({ message: err.message || "Failed to save review" })
  }
})

router.get("/models", async (req, res) => {
  try {
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})
    res.json({
      freeModels: settings.freeModels,
      paidModels: settings.modelSwitching?.paidModelsEnabled ? settings.paidModels : [],
      paidModelsEnabled: settings.modelSwitching?.paidModelsEnabled || false,
      freeModelsEnabled: settings.modelSwitching?.freeModelsEnabled !== false,
      currentPreference: req.user.modelPreference,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load models" })
  }
})

router.patch("/models/preference", async (req, res) => {
  try {
    const { modelId } = req.body
    if (!modelId) {
      return res.status(400).json({ message: "modelId required" })
    }
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})

    const inFree = settings.freeModels?.some((m) => m.id === modelId)
    const inPaid = settings.paidModels?.some((m) => m.id === modelId)
    if (!inFree && !inPaid) {
      return res.status(400).json({ message: "Unknown model id" })
    }
    if (inPaid && !settings.modelSwitching?.paidModelsEnabled) {
      return res.status(403).json({ message: "Paid models are disabled by admin" })
    }

    req.user.modelPreference = modelId
    await req.user.save()

    const existing = settings.perUserModelUsage?.find(
      (p) => String(p.userId) === String(req.user._id)
    )
    if (existing) {
      existing.modelPreference = modelId
    } else {
      settings.perUserModelUsage.push({
        userId: req.user._id,
        modelPreference: modelId,
      })
    }
    await settings.save()

    res.json({ message: "Model preference updated", modelPreference: modelId })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update preference" })
  }
})

router.get("/admin/settings", restrictTo("admin", "owner"), async (_req, res) => {
  try {
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})
    res.json({ settings })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load admin settings" })
  }
})

router.patch("/admin/settings", restrictTo("admin", "owner"), async (req, res) => {
  try {
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})

    if (req.body.freeModels) settings.freeModels = req.body.freeModels
    if (req.body.paidModels) settings.paidModels = req.body.paidModels
    if (req.body.modelSwitching) {
      settings.modelSwitching = {
        ...settings.modelSwitching?.toObject?.() || settings.modelSwitching || {},
        ...req.body.modelSwitching,
      }
    }
    if (req.body.globalFeatureToggles) {
      settings.globalFeatureToggles = {
        ...settings.globalFeatureToggles?.toObject?.() || settings.globalFeatureToggles || {},
        ...req.body.globalFeatureToggles,
      }
    }
    await settings.save()
    res.json({ settings, message: "Admin settings updated" })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update admin settings" })
  }
})

router.post("/admin/models", restrictTo("admin", "owner"), async (req, res) => {
  try {
    const { tier, name, id, description } = req.body
    if (!tier || !name || !id) {
      return res.status(400).json({ message: "tier, name, and id are required" })
    }
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})
    const entry = { name, id, description: description || "" }
    if (tier === "paid") {
      if (settings.paidModels.some((m) => m.id === id)) {
        return res.status(409).json({ message: "Model id already exists in paid list" })
      }
      settings.paidModels.push(entry)
    } else {
      if (settings.freeModels.some((m) => m.id === id)) {
        return res.status(409).json({ message: "Model id already exists in free list" })
      }
      settings.freeModels.push(entry)
    }
    await settings.save()
    res.status(201).json({ settings, message: "Model added" })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to add model" })
  }
})

export default router
