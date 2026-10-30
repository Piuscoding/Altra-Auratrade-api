import jwt from "jsonwebtoken"
import User from "../models/User.js"

export function protect(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized" })
  }
  const token = header.split(" ")[1]
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev-secret")
    req.userId = decoded.id
    req.userRole = decoded.role
    next()
  } catch {
    return res.status(401).json({ message: "Token invalid or expired" })
  }
}

export function restrictTo(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ message: "Forbidden" })
    }
    next()
  }
}

export async function loadUser(req, res, next) {
  try {
    const user = await User.findById(req.userId)
    if (!user || user.isBlocked) {
      return res.status(401).json({ message: "User not found or blocked" })
    }
    req.user = user
    next()
  } catch {
    return res.status(500).json({ message: "Server error" })
  }
}
