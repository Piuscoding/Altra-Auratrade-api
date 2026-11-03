import { Queue, Worker } from "bullmq"
import IORedis from "ioredis"
import { evaluateAllEnabledAutoSignals, evaluateStrategyAutoSignal } from "../services/autoSignalService.js"

const QUEUE_NAME = "auto-signal"

let queue = null
let worker = null
let fallbackTimer = null

function connection() {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379"
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  })
}

export async function startAutoSignalWorker() {
  const enabled = process.env.AUTO_SIGNAL_WORKER !== "0"
  if (!enabled) {
    console.log("Auto-signal worker disabled (AUTO_SIGNAL_WORKER=0)")
    return
  }

  try {
    const conn = connection()
    queue = new Queue(QUEUE_NAME, { connection: conn })
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === "evaluate-all") {
          return evaluateAllEnabledAutoSignals()
        }
        if (job.name === "evaluate-one") {
          return evaluateStrategyAutoSignal(job.data.strategyId)
        }
        return { ok: false, error: "unknown job" }
      },
      { connection: conn.duplicate(), concurrency: 1 }
    )

    worker.on("failed", (job, err) => {
      console.warn("[auto-signal] job failed:", job?.name, err.message)
    })

    await queue.add(
      "evaluate-all",
      {},
      {
        repeat: { every: Number(process.env.AUTO_SIGNAL_TICK_MS || 5 * 60 * 1000) },
        removeOnComplete: 50,
        removeOnFail: 50,
      }
    )

    console.log("Auto-signal BullMQ worker started")
  } catch (err) {
    console.warn("[auto-signal] BullMQ unavailable, using interval fallback:", err.message)
    startFallbackInterval()
  }
}

function startFallbackInterval() {
  if (fallbackTimer) return
  const ms = Number(process.env.AUTO_SIGNAL_TICK_MS || 5 * 60 * 1000)
  fallbackTimer = setInterval(() => {
    evaluateAllEnabledAutoSignals().catch((e) =>
      console.warn("[auto-signal] fallback tick:", e.message)
    )
  }, ms)
  if (fallbackTimer.unref) fallbackTimer.unref()
  console.log("Auto-signal fallback interval started (", ms, "ms )")
}

export async function enqueueStrategyEvaluation(strategyId) {
  if (queue) {
    await queue.add(
      "evaluate-one",
      { strategyId },
      { removeOnComplete: 20, removeOnFail: 20 }
    )
    return { queued: true }
  }
  const result = await evaluateStrategyAutoSignal(strategyId)
  return { queued: false, result }
}

export function getAutoSignalWorkerStatus() {
  return {
    bullmq: Boolean(queue && worker),
    fallback: Boolean(fallbackTimer),
    tickMs: Number(process.env.AUTO_SIGNAL_TICK_MS || 5 * 60 * 1000),
  }
}
