import { Router } from "express"
import { protect, loadUser } from "../middleware/auth.js"
import {
  createChallenge,
  listChallenges,
  getChallenge,
  updateChallenge,
  refreshChallenge,
  pauseChallenge,
  resumeChallenge,
  failChallenge,
} from "../services/propFirmEngine.js"

const router = Router()
router.use(protect, loadUser)

router.get("/", async (req, res) => {
  try {
    const challenges = await listChallenges(req.user._id)
    res.json({ challenges })
  } catch (err) {
    res.status(500).json({ message: "Failed to list challenges" })
  }
})

router.post("/", async (req, res) => {
  try {
    const challenge = await createChallenge(req.user._id, req.body || {})
    res.status(201).json({ challenge })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || "Create failed" })
  }
})

router.get("/:id", async (req, res) => {
  try {
    const challenge = await getChallenge(req.user._id, req.params.id)
    res.json({ challenge })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.patch("/:id", async (req, res) => {
  try {
    const challenge = await updateChallenge(req.user._id, req.params.id, req.body || {})
    res.json({ challenge })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

router.post("/:id/refresh", async (req, res) => {
  try {
    const challenge = await refreshChallenge(req.user._id, req.params.id)
    res.json({ challenge })
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message })
  }
})

export default router
