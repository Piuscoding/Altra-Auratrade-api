/**
 * OpenRouter-only vision client.
 * One model per task. Uses OPENROUTER_API_KEY from env.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

export const DEFAULT_FREE_MODEL = "qwen/qwen3-vl-7b"

export async function callOpenRouterVision({
  modelId,
  systemPrompt,
  userText,
  imageDataUrls = [],
}) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      offline: true,
      error: "OPENROUTER_API_KEY not configured",
      content: null,
    }
  }

  const content = [{ type: "text", text: userText }]
  for (const url of imageDataUrls.slice(0, 12)) {
    if (!url) continue
    content.push({
      type: "image_url",
      image_url: { url },
    })
  }

  const body = {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.FRONTEND_URL || "http://localhost:5173",
      "X-Title": "Altra-AuraTrade",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    return {
      ok: false,
      offline: false,
      error: `OpenRouter ${res.status}: ${errText.slice(0, 500)}`,
      content: null,
    }
  }

  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content || ""
  return {
    ok: true,
    offline: false,
    error: null,
    content: text,
    usage: data?.usage || null,
    model: data?.model || modelId,
  }
}

export function extractJsonFromText(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced ? fenced[1].trim() : text.trim()
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
