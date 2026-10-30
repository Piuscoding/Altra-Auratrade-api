import Redis from "ioredis"

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379"

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 8) {
      return null
    }
    return Math.min(times * 400, 4000)
  },
  reconnectOnError() {
    return false
  },
})

let lastErrorLog = 0
redis.on("connect", () => console.log("Redis connected"))
redis.on("ready", () => console.log("Redis ready"))
redis.on("close", () => {
  const now = Date.now()
  if (now - lastErrorLog > 15000) {
    console.warn("Redis disconnected — vision cache falls back to MongoDB")
    lastErrorLog = now
  }
})
redis.on("error", (err) => {
  const now = Date.now()
  if (now - lastErrorLog > 15000) {
    console.warn("Redis unavailable:", err.message, "— app continues without Redis cache")
    lastErrorLog = now
  }
})

redis.connect().catch(() => {
  console.warn("Redis not running at", redisUrl, "— start Redis for caching, or ignore for now")
})

export default redis
