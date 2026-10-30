import { Router } from "express"
import multer from "multer"
import Strategy from "../models/Strategy.js"
import { protect, loadUser } from "../middleware/auth.js"

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20,
  },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/")
    if (ok) cb(null, true)
    else cb(new Error("Only image and video files are allowed"))
  },
})

function bufferToDataUrl(file) {
  const b64 = file.buffer.toString("base64")
  return `data:${file.mimetype};base64,${b64}`
}

const STEP_TEMPLATES = [
  {
    order: 1,
    title: "Market Structure & Trend",
    hint: "Identify the overall trend on the higher timeframe (higher highs/lows or lower highs/lows).",
  },
  {
    order: 2,
    title: "BOS + CHoCH",
    hint: "Wait for a clear Break of Structure and Change of Character confirming the trend.",
  },
  {
    order: 3,
    title: "Confluence Zones",
    hint: "Order block, fair value gap, or liquidity zone in the direction of the trend.",
  },
  {
    order: 4,
    title: "Entry, SL, TP & RR",
    hint: "Entry at the zone, stop beyond structure, take profit at 1:3+ RR. Invalidation rules.",
  },
]

router.use(protect, loadUser)

router.get("/meta/step-templates", (_req, res) => {
  res.json({ steps: STEP_TEMPLATES })
})


router.get("/meta/feature-toggles", async (_req, res) => {
  try {
    const AdminSettings = (await import("../models/AdminSettings.js")).default
    let settings = await AdminSettings.findOne()
    if (!settings) settings = await AdminSettings.create({})
    res.json({
      globalFeatureToggles: settings.globalFeatureToggles,
      modelSwitching: settings.modelSwitching,
    })
  } catch (err) {
    res.status(500).json({ message: "Failed to load feature toggles" })
  }
})

router.get("/", async (req, res) => {
  try {
    const strategies = await Strategy.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .select("-steps.images.url -video.url -originalAssets")
      .lean()
    res.json({ strategies })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to list strategies" })
  }
})

router.get("/:id", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to load strategy" })
  }
})

router.post("/", async (req, res) => {
  try {
    const { name, sourceType } = req.body
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Strategy name is required" })
    }
    const allowed = ["visual_steps", "video", "hybrid", "manual"]
    const type = allowed.includes(sourceType) ? sourceType : "visual_steps"

    const steps = STEP_TEMPLATES.map((t) => ({
      order: t.order,
      explanation: "",
      images: [],
      aiInterpretation: "",
      confidence: 0,
      userCorrections: "",
    }))

    const strategy = await Strategy.create({
      userId: req.user._id,
      name: String(name).trim(),
      sourceType: type,
      status: "draft",
      steps,
      video: {},
      originalAssets: { images: [], videoUrl: "" },
      riskAdjustment: {
        enabled: false,
        trendAlignment: false,
        newsImpactCheck: false,
        profitLock50: { enabled: false, activationLevel: 50 },
        drawdownGuard: true,
        capitalGuard: true,
      },
    })

    res.status(201).json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to create strategy" })
  }
})

router.patch("/:id", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    if (strategy.status === "archived") {
      return res.status(400).json({ message: "Archived strategies cannot be edited" })
    }

    const {
      name,
      sourceType,
      steps,
      video,
      allowedPairs,
      status,
    } = req.body

    if (name !== undefined) strategy.name = String(name).trim()
    if (sourceType !== undefined) {
      const allowed = ["visual_steps", "video", "hybrid", "manual"]
      if (allowed.includes(sourceType)) strategy.sourceType = sourceType
    }
    if (Array.isArray(allowedPairs)) strategy.allowedPairs = allowedPairs
    if (video && typeof video === "object") {
      strategy.video = { ...strategy.video?.toObject?.() || strategy.video || {}, ...video }
    }
    if (Array.isArray(steps)) {
      strategy.steps = steps.map((s, i) => ({
        order: s.order ?? i + 1,
        explanation: s.explanation || "",
        images: Array.isArray(s.images)
          ? s.images.map((img) =>
              typeof img === "string"
                ? { url: img, annotations: [] }
                : { url: img.url || "", annotations: img.annotations || [] }
            )
          : [],
        aiInterpretation: s.aiInterpretation || "",
        confidence: s.confidence || 0,
        userCorrections: s.userCorrections || "",
      }))
    }

    if (status === "disabled" || status === "draft" || status === "review") {
      strategy.status = status
    }

    await strategy.save()
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to update strategy" })
  }
})

router.post("/:id/upload-step-images", upload.array("images", 3), async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }

    const stepOrder = Number(req.body.stepOrder)
    if (!stepOrder || stepOrder < 1 || stepOrder > 4) {
      return res.status(400).json({ message: "stepOrder must be 1–4" })
    }

    const step = strategy.steps.find((s) => s.order === stepOrder)
    if (!step) {
      return res.status(400).json({ message: "Step not found" })
    }

    if (strategy.sourceType === "video") {
      return res.status(400).json({ message: "Video-only strategies do not accept step images" })
    }

    const maxImages = strategy.sourceType === "hybrid" ? 3 : 3
    const files = req.files || []
    if (files.length === 0) {
      return res.status(400).json({ message: "No images uploaded" })
    }

    const existing = step.images || []
    if (existing.length + files.length > maxImages) {
      return res.status(400).json({
        message: `Maximum ${maxImages} images per step (currently ${existing.length})`,
      })
    }

    const newImages = files.map((f) => ({
      url: bufferToDataUrl(f),
      annotations: [],
    }))
    step.images = [...existing, ...newImages]

    const allUrls = strategy.originalAssets?.images || []
    strategy.originalAssets = {
      images: [...allUrls, ...newImages.map((i) => i.url)],
      videoUrl: strategy.originalAssets?.videoUrl || strategy.video?.url || "",
    }

    await strategy.save()
    res.json({ strategy, added: newImages.length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: err.message || "Upload failed" })
  }
})

router.post("/:id/upload-video", upload.single("video"), async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }

    if (strategy.sourceType === "visual_steps") {
      return res.status(400).json({ message: "Step-by-step visual strategies do not use video" })
    }

    if (!req.file) {
      return res.status(400).json({ message: "No video uploaded" })
    }

    const dataUrl = bufferToDataUrl(req.file)
    strategy.video = {
      ...(strategy.video?.toObject?.() || strategy.video || {}),
      url: dataUrl,
    }
    strategy.originalAssets = {
      images: strategy.originalAssets?.images || [],
      videoUrl: dataUrl,
    }

    await strategy.save()
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: err.message || "Video upload failed" })
  }
})

router.delete("/:id/step/:stepOrder/image/:imageIndex", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    const stepOrder = Number(req.params.stepOrder)
    const imageIndex = Number(req.params.imageIndex)
    const step = strategy.steps.find((s) => s.order === stepOrder)
    if (!step || !step.images || !step.images[imageIndex]) {
      return res.status(404).json({ message: "Image not found" })
    }
    step.images.splice(imageIndex, 1)
    await strategy.save()
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to remove image" })
  }
})

router.post("/:id/disable", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    strategy.status = "disabled"
    await strategy.save()
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to disable strategy" })
  }
})

router.post("/:id/enable", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }
    if (strategy.status !== "disabled") {
      return res.status(400).json({ message: "Only disabled strategies can be re-enabled this way" })
    }
    strategy.status = "draft"
    await strategy.save()
    res.json({ strategy })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to enable strategy" })
  }
})

router.post("/:id/submit-review", async (req, res) => {
  try {
    const strategy = await Strategy.findOne({
      _id: req.params.id,
      userId: req.user._id,
    })
    if (!strategy) {
      return res.status(404).json({ message: "Strategy not found" })
    }

    const type = strategy.sourceType
    if (type === "visual_steps" || type === "hybrid") {
      for (const step of strategy.steps) {
        if (!step.explanation || !step.explanation.trim()) {
          return res.status(400).json({
            message: `Step ${step.order} needs an explanation before review`,
          })
        }
        if (type === "visual_steps" && (!step.images || step.images.length === 0)) {
          return res.status(400).json({
            message: `Step ${step.order} needs at least 1 image (max 3)`,
          })
        }
      }
    }
    if (type === "video" || type === "hybrid") {
      if (!strategy.video?.url) {
        return res.status(400).json({ message: "Video is required for this method" })
      }
    }

    strategy.status = "review"
    await strategy.save()

    let vision = null
    if (req.body?.runVision !== false) {
      try {
        const { runVisionAnalysis } = await import("../services/visionPipeline.js")
        vision = await runVisionAnalysis(strategy._id, req.user._id, { force: false })
        strategy = vision.strategy
      } catch (vErr) {
        console.error("[submit-review] vision:", vErr.message)
      }
    }

    res.json({
      strategy,
      job: vision?.job || null,
      cached: vision?.cached || false,
      offline: vision?.offline || false,
      message: vision
        ? "Strategy submitted and vision analysis completed"
        : "Strategy submitted for review",
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Failed to submit for review" })
  }
})

export default router
