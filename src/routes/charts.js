import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import { getWorkspaceBundle, buildNewsImpactMarkers } from "../services/chartService.js"
import { getCandles } from "../services/marketDataService.js"
import ChartDrawing from "../models/ChartDrawing.js"
import { annotateChart, getCachedAnnotation } from "../services/aiChartAssistService.js"

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
    const data = await getCandles({
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
    const series = await getCandles({ pair, timeframe: req.query.timeframe || "M15", count: 100 })
    const markers = buildNewsImpactMarkers(pair, series.candles)
    res.json({ pair, markers, source: series.source })
  } catch (err) {
    res.status(500).json({ message: "Failed to load news markers" })
  }
})


router.get("/drawings", async (req, res) => {
  try {
    const pair = String(req.query.pair || "EURUSD").toUpperCase()
    const timeframe = String(req.query.timeframe || "M15")
    const doc = await ChartDrawing.findOne({
      userId: req.user._id,
      pair,
      timeframe,
    })
    res.json({ drawings: doc?.drawings || [] })
  } catch (err) {
    res.status(500).json({ message: "Failed to load drawings" })
  }
})

router.put("/drawings", async (req, res) => {
  try {
    const pair = String(req.body.pair || "EURUSD").toUpperCase()
    const timeframe = String(req.body.timeframe || "M15")
    const drawings = Array.isArray(req.body.drawings) ? req.body.drawings : []
    const doc = await ChartDrawing.findOneAndUpdate(
      { userId: req.user._id, pair, timeframe },
      { $set: { drawings } },
      { upsert: true, new: true }
    )
    res.json({ drawings: doc.drawings })
  } catch (err) {
    res.status(500).json({ message: "Failed to save drawings" })
  }
})


router.get("/ai-annotation", async (req, res) => {
  try {
    const pair = String(req.query.pair || "EURUSD").toUpperCase()
    const timeframe = String(req.query.timeframe || "M15")
    const strategyId = req.query.strategyId || null
    const cached = await getCachedAnnotation(req.user._id, { pair, timeframe, strategyId })
    res.json({ annotation: cached, cached: Boolean(cached) })
  } catch (err) {
    res.status(500).json({ message: "Failed to load annotation cache" })
  }
})

router.post("/ai-annotate", async (req, res) => {
  try {
    const body = req.body || {}
    const result = await annotateChart(req.user._id, {
      pair: body.pair,
      timeframe: body.timeframe,
      strategyId: body.strategyId,
      force: Boolean(body.force),
    })
    if (!result.ok) {
      return res.status(result.status || 400).json({ message: result.message })
    }
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: err.message || "AI annotation failed" })
  }
})

export default router
