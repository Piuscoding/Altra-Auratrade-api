import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import { getMarketStatus } from "../utils/marketHours.js"
import { getEconomicCalendar, newsKeysStatus } from "../services/newsCalendarService.js"
import { marketDataKeysStatus } from "../services/marketDataService.js"
import { FOREX_PAIRS, TIMEFRAMES } from "../utils/forexPairs.js"
import { refreshNewsCache } from "../services/newsFilterEngine.js"

const router = Router()

router.get("/status", (_req, res) => {
  res.json(getMarketStatus())
})

router.get("/pairs", (_req, res) => {
  res.json({ pairs: FOREX_PAIRS, timeframes: TIMEFRAMES })
})

router.get("/providers-status", protect, loadUser, (_req, res) => {
  res.json({
    marketData: marketDataKeysStatus(),
    news: newsKeysStatus(),
  })
})

router.get("/calendar", protect, loadUser, async (req, res) => {
  try {
    const days = Number(req.query.days) || 7
    const data = await getEconomicCalendar({ days })
    await refreshNewsCache()
    res.json(data)
  } catch (err) {
    res.status(500).json({ message: err.message || "Calendar failed" })
  }
})

export default router
