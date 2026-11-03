import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import { runBacktest, listBacktests, getBacktest } from "../services/backtestService.js"
import { writeAudit } from "../services/auditService.js"

const router = Router()
router.use(protect, loadUser)

router.post("/run", async (req, res) => {
  try {
    const run = await runBacktest(req.user._id, req.body)
    await writeAudit({
      userId: req.user._id,
      action: "backtest.run",
      resource: "BacktestRun",
      resourceId: run._id,
      summary: `Backtest ${run.mode} ${run.pair} ${run.timeframe}`,
      details: { strategyId: run.strategyId, results: { trades: run.results?.trades, winRate: run.results?.winRate } },
    })
    res.status(201).json({ run })
  } catch (err) {
    console.error(err)
    res.status(err.status || 500).json({ message: err.message || "Backtest failed" })
  }
})

router.get("/", async (req, res) => {
  try {
    const runs = await listBacktests(req.user._id, {
      strategyId: req.query.strategyId,
      limit: Number(req.query.limit) || 30,
    })
    res.json({ runs })
  } catch (err) {
    res.status(500).json({ message: "Failed to list backtests" })
  }
})

router.get("/:id", async (req, res) => {
  try {
    const run = await getBacktest(req.user._id, req.params.id)
    res.json({ run })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

export default router
