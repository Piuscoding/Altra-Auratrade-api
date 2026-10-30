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
import {
  seedDemoNewsEvent,
  clearDemoNewsEvents,
  getUpcomingEvents,
} from "../services/newsFilterEngine.js"

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
    const trades = await listTrades(req.user._id, { status: req.query.status })
    res.json({ trades })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list trades" })
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

router.post("/news/demo-seed", async (req, res) => {
  const name = req.body?.name || "FOMC"
  const minutesFromNow = Number(req.body?.minutesFromNow) || 10
  const event = seedDemoNewsEvent({ name, minutesFromNow, impact: "high" })
  res.json({ event, message: "Demo high-impact event seeded for testing news filter" })
})

router.delete("/news/demo", async (_req, res) => {
  clearDemoNewsEvents()
  res.json({ message: "Demo news events cleared" })
})

export default router
