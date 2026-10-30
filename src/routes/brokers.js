import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import {
  createBrokerAccount,
  listBrokerAccounts,
  getBrokerAccount,
  disconnectBroker,
  reconnectBroker,
  assignStrategy,
  unassignStrategy,
  updateBrokerSettings,
  syncBalance,
} from "../services/brokerService.js"

const router = Router()
router.use(protect, loadUser)

router.get("/", async (req, res) => {
  try {
    const accounts = await listBrokerAccounts(req.user._id)
    res.json({
      accounts,
      metaApiConfigured: Boolean(process.env.METAAPI_TOKEN),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list broker accounts" })
  }
})

router.get("/:id", async (req, res) => {
  try {
    const account = await getBrokerAccount(req.user._id, req.params.id)
    res.json({ account })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/", async (req, res) => {
  try {
    const result = await createBrokerAccount(req.user._id, req.body)
    res.status(201).json(result)
  } catch (err) {
    console.error(err)
    res.status(err.status || 500).json({ message: err.message || "Create failed" })
  }
})

router.post("/:id/disconnect", async (req, res) => {
  try {
    const account = await disconnectBroker(req.user._id, req.params.id)
    res.json({ account, message: "Disconnected" })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/:id/connect", async (req, res) => {
  try {
    const account = await reconnectBroker(req.user._id, req.params.id)
    res.json({ account, message: "Connected" })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/:id/assign-strategy", async (req, res) => {
  try {
    const { strategyId } = req.body
    if (!strategyId) {
      return res.status(400).json({ message: "strategyId is required" })
    }
    const result = await assignStrategy(req.user._id, req.params.id, strategyId)
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/:id/unassign-strategy", async (req, res) => {
  try {
    const result = await unassignStrategy(req.user._id, req.params.id)
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.patch("/:id/settings", async (req, res) => {
  try {
    const account = await updateBrokerSettings(req.user._id, req.params.id, req.body)
    res.json({ account })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/:id/sync", async (req, res) => {
  try {
    const result = await syncBalance(req.user._id, req.params.id)
    res.json(result)
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

export default router
