import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import { getWorkspaceBundle, generateCandles, buildNewsImpactMarkers } from "../services/chartService.js"

const router = Router()
router.use(protect, loadUser)

router.get("/workspace", async (req, res) => {
  try {
    const bundle = await getWorkspaceBundle(req.user._id, req.query)
    res.json(bundle)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: err.message || "Failed to load chart workspace" })
  }
})

router.get("/ohlc", async (req, res) => {
  try {
    const data = generateCandles({
      pair: req.query.pair,
      timeframe: req.query.timeframe,
      count: Number(req.query.count) || 200,
    })
    res.json(data)
  } catch (err) {
    res.status(500).json({ message: "Failed to load OHLC" })
  }
})

router.get("/news-markers", async (req, res) => {
  try {
    const pair = (req.query.pair || "EURUSD").toUpperCase()
    const series = generateCandles({ pair, timeframe: req.query.timeframe || "M15", count: 100 })
    const markers = buildNewsImpactMarkers(pair, series.candles)
    res.json({ pair, markers })
  } catch (err) {
    res.status(500).json({ message: "Failed to load news markers" })
  }
})

export default router
