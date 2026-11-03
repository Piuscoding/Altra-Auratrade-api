import crypto from "crypto"

export function encryptSecret(plain) {
  if (!plain) return null
  const key = crypto
    .createHash("sha256")
    .update(process.env.JWT_SECRET || "dev-secret-for-local-only")
    .digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

export function decryptSecret(blob) {
  if (!blob) return null
  try {
    const buf = Buffer.from(blob, "base64")
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const data = buf.subarray(28)
    const key = crypto
      .createHash("sha256")
      .update(process.env.JWT_SECRET || "dev-secret-for-local-only")
      .digest()
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}
