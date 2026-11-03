import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import {
  processIncomingSignal,
  listSignals,
  listTrades,
  openTrade,
  closeTrade,
  killAll,
  runRiskAdjustment,
  updateMarkPrice,
} from "../services/tradingEngine.js"
import { getUpcomingEvents } from "../services/newsFilterEngine.js"

const router = Router()
router.use(protect, loadUser)

router.post("/signals", async (req, res) => {
  try {
    const result = await processIncomingSignal(req.user._id, req.body)
    res.status(result.accepted ? 201 : 200).json(result)
  } catch (err) {
    console.error(err)
    res.status(err.status || 500).json({ message: err.message || "Signal processing failed" })
  }
})

router.get("/signals", async (req, res) => {
  try {
    const signals = await listSignals(req.user._id)
    res.json({ signals })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list signals" })
  }
})

router.get("/trades", async (req, res) => {
  try {
    const trades = await listTrades(req.user._id, {
      status: req.query.status,
      strategyId: req.query.strategyId,
      accountType: req.query.accountType,
      outcome: req.query.outcome,
      from: req.query.from,
      to: req.query.to,
      limit: Number(req.query.limit) || 500,
    })
    res.json({ trades })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list trades" })
  }
})

router.post("/trades/:id/sync-status", async (req, res) => {
  try {
    const { syncTradeOrderStatus } = await import("../services/orderSyncService.js")
    const result = await syncTradeOrderStatus(req.user._id, req.params.id)
    if (!result.ok) {
      return res.status(400).json({ message: result.error || "Sync failed" })
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ message: err.message || "Order status sync failed" })
  }
})

router.post("/trades/:id/open", async (req, res) => {
  try {
    const trade = await openTrade(req.user._id, req.params.id)
    res.json({ trade })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/trades/:id/close", async (req, res) => {
  try {
    const trade = await closeTrade(req.user._id, req.params.id, {
      pnl: Number(req.body?.pnl) || 0,
    })
    res.json({ trade })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/trades/:id/mark", async (req, res) => {
  try {
    const markPrice = Number(req.body?.markPrice)
    if (Number.isNaN(markPrice)) {
      return res.status(400).json({ message: "markPrice required" })
    }
    const trade = await updateMarkPrice(req.user._id, req.params.id, markPrice)
    res.json({ trade })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/trades/:id/risk-adjust", async (req, res) => {
  try {
    const result = await runRiskAdjustment(req.user._id, req.params.id)
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/kill-switch", async (req, res) => {
  try {
    const result = await killAll(req.user._id)
    res.json({ message: "Kill switch executed", ...result })
  } catch (err) {
    res.status(500).json({ message: "Kill switch failed" })
  }
})

router.get("/news/upcoming", async (_req, res) => {
  res.json({ events: getUpcomingEvents(180) })
})

export default router
