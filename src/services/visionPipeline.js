import crypto from "crypto"
import Strategy from "../models/Strategy.js"
import VisionJob from "../models/VisionJob.js"
import ModelCache from "../models/ModelCache.js"
import AdminSettings from "../models/AdminSettings.js"
import User from "../models/User.js"
import redis from "../config/redis.js"
import { callOpenRouterVision, extractJsonFromText, DEFAULT_FREE_MODEL } from "./openrouter.js"

const SYSTEM_PROMPT = `You are Altra-AuraTrade Vision Pipeline. Analyze forex strategy chart steps and produce STRICT JSON only (no markdown outside JSON).

Schema:
{
  "steps": [
    {
      "order": 1,
      "summary": "string",
      "patterns": ["string"],
      "levels": { "entry": "string|null", "stopLoss": "string|null", "takeProfit": "string|null", "structurePoints": ["string"] },
      "confidence": 0-100,
      "notes": "string"
    }
  ],
  "rules": {
    "entry": "string",
    "stopLoss": "string",
    "takeProfit": "string",
    "filters": ["string"],
    "minRR": "string",
    "direction": "long|short|long_short",
    "timeframes": ["string"]
  },
  "plottedLevels": {
    "entry": "string|null",
    "stopLoss": "string|null",
    "takeProfit": "string|null",
    "structurePoints": ["string"]
  },
  "overallSummary": "string",
  "riskNotes": ["string"]
}

Extract numeric prices when visible. Be precise. One coherent strategy from all steps.`

function hashPayload(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 40)
}

function computeConfidence({ structured, steps, modelAgreed }) {
  let base = 70
  const reasons = []
  let penalties = 0
  let bonuses = 0

  if (!structured) {
    penalties += 40
    reasons.push("Unstructured or unreadable model output (−40)")
  } else {
    const rules = structured.rules || {}
    if (!rules.entry || !rules.stopLoss) {
      penalties += 20
      reasons.push("Missing clear entry or stop loss (−20)")
    } else {
      bonuses += 10
      reasons.push("Clear entry/SL language (+10)")
    }
    if (rules.minRR) {
      bonuses += 5
      reasons.push("RR specified (+5)")
    }
    const stepScores = (structured.steps || []).map((s) => Number(s.confidence) || 0)
    if (stepScores.length >= 4) {
      bonuses += 10
      reasons.push("Consistent coverage across 4 steps (+10)")
    }
    const avgStep =
      stepScores.length > 0
        ? stepScores.reduce((a, b) => a + b, 0) / stepScores.length
        : 50
    base = Math.round((base + avgStep) / 2)
  }

  const emptyExplanations = (steps || []).filter((s) => !s.explanation?.trim()).length
  if (emptyExplanations > 0) {
    penalties += emptyExplanations * 5
    reasons.push(`Vague/missing step explanations (−${emptyExplanations * 5})`)
  }

  if (modelAgreed === false) {
    penalties += 15
    reasons.push("Low model agreement (−15)")
  }

  let final = Math.max(0, Math.min(100, base + bonuses - penalties))
  return {
    base,
    penalties,
    bonuses,
    final,
    reasons,
  }
}

function buildOfflineStructured(strategy) {
  const steps = (strategy.steps || []).map((s) => ({
    order: s.order,
    summary: s.explanation?.slice(0, 280) || `Step ${s.order} analysis pending live model`,
    patterns: ["structure", "awaiting_live_model"],
    levels: {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      structurePoints: [],
    },
    confidence: s.explanation?.trim() ? 55 : 30,
    notes: "OPENROUTER_API_KEY not set — offline draft interpretation from your text only.",
  }))
  return {
    steps,
    rules: {
      entry: "Derived from step explanations (offline mode)",
      stopLoss: "Set beyond invalidation structure",
      takeProfit: "Target minimum 1:2 to 1:3 RR",
      filters: ["session_constraints", "news_filter"],
      minRR: "1:2",
      direction: "long_short",
      timeframes: ["H1", "M15"],
    },
    plottedLevels: {
      entry: null,
      stopLoss: null,
      takeProfit: null,
      structurePoints: [],
    },
    overallSummary:
      "Offline analysis built from your written steps. Add OPENROUTER_API_KEY for full vision extraction of prices and patterns from charts.",
    riskNotes: ["Verify all levels manually before demo or live use"],
    offline: true,
  }
}

async function resolveModelForUser(userId) {
  const user = await User.findById(userId)
  let settings = await AdminSettings.findOne()
  if (!settings) {
    settings = await AdminSettings.create({})
  }

  const perUser = settings.perUserModelUsage?.find(
    (p) => String(p.userId) === String(userId)
  )
  if (perUser?.modelPreference && perUser.modelPreference !== "free") {
    const paidAllowed = settings.modelSwitching?.paidModelsEnabled
    const inPaid = settings.paidModels?.some((m) => m.id === perUser.modelPreference || m.name === perUser.modelPreference)
    const inFree = settings.freeModels?.some((m) => m.id === perUser.modelPreference || m.name === perUser.modelPreference)
    if (inFree || (paidAllowed && inPaid)) {
      const found =
        settings.freeModels.find((m) => m.id === perUser.modelPreference || m.name === perUser.modelPreference) ||
        settings.paidModels.find((m) => m.id === perUser.modelPreference || m.name === perUser.modelPreference)
      return { modelId: found?.id || perUser.modelPreference, modelName: found?.name || perUser.modelPreference }
    }
  }

  if (user?.modelPreference && user.modelPreference !== "free") {
    const found =
      settings.freeModels?.find((m) => m.id === user.modelPreference) ||
      settings.paidModels?.find((m) => m.id === user.modelPreference)
    if (found) {
      const isPaid = settings.paidModels?.some((m) => m.id === found.id)
      if (!isPaid || settings.modelSwitching?.paidModelsEnabled) {
        return { modelId: found.id, modelName: found.name }
      }
    }
  }

  const freeDefault = settings.freeModels?.[0]
  return {
    modelId: freeDefault?.id || DEFAULT_FREE_MODEL,
    modelName: freeDefault?.name || "Qwen3-VL 7B",
  }
}

function ttlForStrategy(strategy) {
  if (strategy.status === "live" || strategy.status === "demo") return 3600
  return 86400
}

export async function runVisionAnalysis(strategyId, userId, { force = false } = {}) {
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    throw Object.assign(new Error("Strategy not found"), { status: 404 })
  }

  const { modelId, modelName } = await resolveModelForUser(userId)

  const payloadFingerprint = {
    strategyId: String(strategy._id),
    modelId,
    sourceType: strategy.sourceType,
    steps: (strategy.steps || []).map((s) => ({
      order: s.order,
      explanation: s.explanation,
      imageCount: s.images?.length || 0,
      imageHashes: (s.images || []).map((i) =>
        crypto.createHash("md5").update(String(i.url || "").slice(0, 2000)).digest("hex")
      ),
    })),
    videoPresent: Boolean(strategy.video?.url),
  }
  const cacheKey = `vision:${hashPayload(payloadFingerprint)}`
  const ttl = ttlForStrategy(strategy)

  if (!force) {
    try {
      const cachedRedis = await redis.get(cacheKey)
      if (cachedRedis) {
        const parsed = JSON.parse(cachedRedis)
        const job = await VisionJob.create({
          strategyId: strategy._id,
          userId,
          status: "completed",
          inputType: strategy.sourceType,
          modelId,
          modelName,
          structuredResult: parsed.structuredResult,
          confidenceBreakdown: parsed.confidenceBreakdown,
          overallConfidence: parsed.overallConfidence,
          cached: true,
          completedAt: new Date(),
          rawOutputs: { source: "redis" },
        })
        strategy.overallConfidence = parsed.overallConfidence
        if (parsed.structuredResult?.rules) strategy.rules = parsed.structuredResult.rules
        if (parsed.structuredResult?.plottedLevels) {
          strategy.plottedLevels = parsed.structuredResult.plottedLevels
        }
        if (Array.isArray(parsed.structuredResult?.steps)) {
          strategy.steps = strategy.steps.map((s) => {
            const ai = parsed.structuredResult.steps.find((x) => x.order === s.order)
            if (!ai) return s
            s.aiInterpretation = ai.summary || s.aiInterpretation
            s.confidence = ai.confidence ?? s.confidence
            return s
          })
        }
        if (strategy.status === "draft") strategy.status = "review"
        await strategy.save()
        return { job, strategy, cached: true }
      }
    } catch (redisErr) {
      console.warn("[vision] Redis cache read skipped:", redisErr.message)
    }

    const mongoCache = await ModelCache.findOne({
      cacheKey,
      expiresAt: { $gt: new Date() },
    })
    if (mongoCache?.cachedResult) {
      try {
        await redis.setex(cacheKey, ttl, JSON.stringify(mongoCache.cachedResult))
      } catch {
        /* optional */
      }
      const parsed = mongoCache.cachedResult
      const job = await VisionJob.create({
        strategyId: strategy._id,
        userId,
        status: "completed",
        inputType: strategy.sourceType,
        modelId,
        modelName,
        structuredResult: parsed.structuredResult,
        confidenceBreakdown: parsed.confidenceBreakdown,
        overallConfidence: parsed.overallConfidence,
        cached: true,
        completedAt: new Date(),
        rawOutputs: { source: "mongodb" },
      })
      strategy.overallConfidence = parsed.overallConfidence
      if (parsed.structuredResult?.rules) strategy.rules = parsed.structuredResult.rules
      if (parsed.structuredResult?.plottedLevels) {
        strategy.plottedLevels = parsed.structuredResult.plottedLevels
      }
      if (strategy.status === "draft") strategy.status = "review"
      await strategy.save()
      return { job, strategy, cached: true }
    }
  }

  const job = await VisionJob.create({
    strategyId: strategy._id,
    userId,
    status: "processing",
    inputType: strategy.sourceType,
    modelId,
    modelName,
  })

  try {
    const imageDataUrls = []
    for (const step of strategy.steps || []) {
      for (const img of step.images || []) {
        if (img.url) imageDataUrls.push(img.url)
      }
    }

    const userText = [
      `Strategy name: ${strategy.name}`,
      `Source type: ${strategy.sourceType}`,
      `Analyze the following ${strategy.steps?.length || 0} steps:`,
      ...(strategy.steps || []).map(
        (s) =>
          `Step ${s.order}: ${s.explanation || "(no explanation)"}\nImages attached for this step: ${(s.images || []).length}`
      ),
      strategy.video?.url
        ? "A strategy video is associated (key-frame extraction runs when video model path is available; use step images/text primarily)."
        : "",
      "Return JSON only matching the schema.",
    ]
      .filter(Boolean)
      .join("\n\n")

    let structured
    let rawContent = null
    let offline = false

    const visionRes = await callOpenRouterVision({
      modelId,
      systemPrompt: SYSTEM_PROMPT,
      userText,
      imageDataUrls,
    })

    if (visionRes.offline || !visionRes.ok) {
      offline = true
      structured = buildOfflineStructured(strategy)
      rawContent = visionRes.error || "offline"
    } else {
      rawContent = visionRes.content
      structured = extractJsonFromText(visionRes.content)
      if (!structured) {
        structured = buildOfflineStructured(strategy)
        structured.overallSummary =
          "Model returned non-JSON output. Offline fallback applied. Re-run analysis after adjusting the strategy."
        structured.parseError = true
      }
    }

    const confidenceBreakdown = computeConfidence({
      structured,
      steps: strategy.steps,
      modelAgreed: !structured?.parseError && !offline,
    })

    job.status = "completed"
    job.rawOutputs = { content: typeof rawContent === "string" ? rawContent.slice(0, 20000) : rawContent }
    job.structuredResult = structured
    job.confidenceBreakdown = confidenceBreakdown
    job.overallConfidence = confidenceBreakdown.final
    job.completedAt = new Date()
    job.cached = false
    await job.save()

    strategy.overallConfidence = confidenceBreakdown.final
    strategy.rules = structured.rules || strategy.rules
    strategy.plottedLevels = structured.plottedLevels || strategy.plottedLevels
    strategy.steps = strategy.steps.map((s) => {
      const ai = (structured.steps || []).find((x) => x.order === s.order)
      if (ai) {
        s.aiInterpretation = ai.summary || JSON.stringify(ai)
        s.confidence = ai.confidence ?? confidenceBreakdown.final
      }
      return s
    })
    if (strategy.status === "draft" || strategy.status === "review") {
      strategy.status = "review"
    }
    await strategy.save()

    const cachePayload = {
      structuredResult: structured,
      confidenceBreakdown,
      overallConfidence: confidenceBreakdown.final,
      modelId,
    }
    try {
      await redis.setex(cacheKey, ttl, JSON.stringify(cachePayload))
    } catch (e) {
      console.warn("[vision] Redis write skipped:", e.message)
    }
    await ModelCache.findOneAndUpdate(
      { cacheKey },
      {
        strategyId: strategy._id,
        modelId,
        cacheKey,
        cachedResult: cachePayload,
        ttlSeconds: ttl,
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
      { upsert: true }
    )

    return { job, strategy, cached: false, offline }
  } catch (err) {
    job.status = "failed"
    job.errorMessage = err.message
    job.completedAt = new Date()
    await job.save()
    throw err
  }
}

export async function getLatestVisionJob(strategyId, userId) {
  return VisionJob.findOne({ strategyId, userId }).sort({ createdAt: -1 })
}

export async function applyUserCorrections(strategyId, userId, { steps, rules, plottedLevels, approve }) {
  const strategy = await Strategy.findOne({ _id: strategyId, userId })
  if (!strategy) {
    throw Object.assign(new Error("Strategy not found"), { status: 404 })
  }

  if (Array.isArray(steps)) {
    strategy.steps = strategy.steps.map((s) => {
      const patch = steps.find((x) => x.order === s.order)
      if (!patch) return s
      if (patch.userCorrections !== undefined) s.userCorrections = patch.userCorrections
      if (patch.explanation !== undefined) s.explanation = patch.explanation
      return s
    })
  }
  if (rules && typeof rules === "object") {
    strategy.rules = { ...strategy.rules, ...rules }
  }
  if (plottedLevels && typeof plottedLevels === "object") {
    strategy.plottedLevels = { ...strategy.plottedLevels, ...plottedLevels }
  }
  if (approve === true) {
    strategy.status = "approved"
  }
  await strategy.save()
  return strategy
}

export async function clearVisionCacheForStrategy(strategyId) {
  await ModelCache.deleteMany({ strategyId })
  try {
    const keys = await redis.keys("vision:*")
    if (keys.length) {
      // only safe on single-tenant dev; production should use keyed delete by known hash
      // we skip bulk delete of all vision keys for safety
    }
  } catch {
    /* optional */
  }
}
