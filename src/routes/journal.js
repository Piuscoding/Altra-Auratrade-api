import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import Trade from "../models/Trade.js"
import Signal from "../models/Signal.js"
import { listTrades } from "../services/tradingEngine.js"

const router = Router()
router.use(protect, loadUser)

function outcomeOf(t) {
  if (t.outcome) return t.outcome
  if (t.status === "closed") {
    const pnl = Number(t.pnl) || 0
    if (pnl > 0) return "win"
    if (pnl < 0) return "loss"
    return "breakeven"
  }
  if (["cancelled", "rejected"].includes(t.status)) return "cancelled"
  if (String(t.status || "").startsWith("skipped")) return "skipped"
  return "open"
}

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
    const enriched = trades.map((t) => {
      const o = t.toObject()
      o.computedOutcome = outcomeOf(o)
      return o
    })
    const closed = enriched.filter((t) => t.status === "closed")
    const wins = closed.filter((t) => outcomeOf(t) === "win").length
    const losses = closed.filter((t) => outcomeOf(t) === "loss").length
    const pnl = closed.reduce((s, t) => s + (Number(t.pnl) || 0), 0)
    res.json({
      trades: enriched,
      stats: {
        closed: closed.length,
        wins,
        losses,
        winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(2)) : 0,
        netPnl: Number(pnl.toFixed(4)),
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load journal trades" })
  }
})

router.get("/calendar", async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear()
    const month = Number(req.query.month) || new Date().getUTCMonth() + 1
    const start = new Date(Date.UTC(year, month - 1, 1))
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
    const trades = await Trade.find({
      userId: req.user._id,
      createdAt: { $gte: start, $lte: end },
    }).lean()
    const byDay = {}
    for (const t of trades) {
      const key = new Date(t.closedAt || t.createdAt).toISOString().slice(0, 10)
      if (!byDay[key]) byDay[key] = { date: key, trades: 0, wins: 0, losses: 0, pnl: 0 }
      byDay[key].trades += 1
      const pnl = Number(t.pnl) || 0
      byDay[key].pnl += pnl
      if (t.status === "closed") {
        if (pnl > 0) byDay[key].wins += 1
        else if (pnl < 0) byDay[key].losses += 1
      }
    }
    res.json({ year, month, days: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)) })
  } catch (err) {
    res.status(500).json({ message: "Failed to load calendar" })
  }
})

router.patch("/trades/:id", async (req, res) => {
  try {
    const trade = await Trade.findOne({ _id: req.params.id, userId: req.user._id })
    if (!trade) return res.status(404).json({ message: "Trade not found" })
    if (typeof req.body.journalNotes === "string") trade.journalNotes = req.body.journalNotes
    if (Array.isArray(req.body.journalTags)) trade.journalTags = req.body.journalTags.map(String)
    if (typeof req.body.journalReviewed === "boolean") trade.journalReviewed = req.body.journalReviewed
    await trade.save()
    res.json({ trade })
  } catch (err) {
    res.status(500).json({ message: "Failed to update journal entry" })
  }
})

router.get("/export.csv", async (req, res) => {
  try {
    const trades = await listTrades(req.user._id, {
      strategyId: req.query.strategyId,
      accountType: req.query.accountType,
      from: req.query.from,
      to: req.query.to,
      limit: 2000,
    })
    const header = [
      "id",
      "pair",
      "direction",
      "status",
      "outcome",
      "pnl",
      "accountType",
      "strategyId",
      "entry",
      "sl",
      "tp",
      "createdAt",
      "closedAt",
      "notes",
    ]
    const rows = trades.map((t) => {
      const o = t.toObject ? t.toObject() : t
      return [
        o._id,
        o.pair,
        o.direction,
        o.status,
        outcomeOf(o),
        o.pnl,
        o.accountType,
        o.strategyId,
        o.entryPrice,
        o.stopLoss,
        o.takeProfit,
        o.createdAt?.toISOString?.() || o.createdAt,
        o.closedAt?.toISOString?.() || o.closedAt || "",
        JSON.stringify(o.journalNotes || ""),
      ].join(",")
    })
    const csv = [header.join(","), ...rows].join("\n")
    res.setHeader("Content-Type", "text/csv")
    res.setHeader("Content-Disposition", "attachment; filename=altra-journal.csv")
    res.send(csv)
  } catch (err) {
    res.status(500).json({ message: "Export failed" })
  }
})

router.get("/signals", async (req, res) => {
  try {
    const q = { userId: req.user._id }
    if (req.query.strategyId) q.strategyId = req.query.strategyId
    const signals = await Signal.find(q).sort({ createdAt: -1 }).limit(200)
    res.json({ signals })
  } catch (err) {
    res.status(500).json({ message: "Failed to load signals" })
  }
})

export default router
