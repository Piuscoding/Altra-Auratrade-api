import { Router } from "express"
import { protect, loadUser, restrictTo } from "../middleware/auth.js"
import {
  listSnapshots,
  evaluateStrategyPromotion,
  getPromotionGates,
  DEFAULT_PROMOTION_GATES,
} from "../services/learningService.js"
import AdminSettings from "../models/AdminSettings.js"

const router = Router()

router.get("/snapshots", protect, loadUser, async (req, res) => {
  try {
    const snapshots = await listSnapshots(req.user._id, {
      strategyId: req.query.strategyId,
      limit: Number(req.query.limit) || 30,
    })
    res.json({ snapshots })
  } catch (err) {
    res.status(500).json({ message: "Failed to list snapshots" })
  }
})

router.get("/promotion/:strategyId", protect, loadUser, async (req, res) => {
  try {
    const data = await evaluateStrategyPromotion(req.params.strategyId, req.user._id)
    res.json(data)
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.get("/gates", protect, loadUser, async (_req, res) => {
  try {
    const gates = await getPromotionGates()
    res.json({ gates })
  } catch (err) {
    res.status(500).json({ message: "Failed to load gates" })
  }
})

router.patch("/gates", protect, loadUser, restrictTo("admin", "owner"), async (req, res) => {
  try {
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})
    const body = req.body || {}
    const next = { ...(settings.promotionGates || {}), ...DEFAULT_PROMOTION_GATES }
    for (const key of Object.keys(DEFAULT_PROMOTION_GATES)) {
      if (body[key] !== undefined) next[key] = body[key]
    }
    settings.promotionGates = next
    await settings.save()
    res.json({ gates: settings.promotionGates, message: "Promotion gates saved" })
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to save gates" })
  }
})

export default router
