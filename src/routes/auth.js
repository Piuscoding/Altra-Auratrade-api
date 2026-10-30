import { Router } from "express"
import jwt from "jsonwebtoken"
import crypto from "crypto"
import User from "../models/User.js"
import { protect, loadUser } from "../middleware/auth.js"
import { sendPasswordResetEmail } from "../utils/email.js"

const router = Router()

function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  )
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ message: "All fields are required" })
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" })
    }
    const exists = await User.findOne({ email: email.toLowerCase() })
    if (exists) {
      return res.status(409).json({ message: "Email already registered" })
    }
    const user = await User.create({
      email,
      password,
      firstName,
      lastName,
      modelPreference: "qwen/qwen3-vl-7b",
    })
    const token = signToken(user)
    res.status(201).json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isBlocked: user.isBlocked,
        modelPreference: user.modelPreference,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Registration failed" })
  }
})

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" })
    }
    const user = await User.findOne({ email: email.toLowerCase() }).select("+password")
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" })
    }
    if (user.isBlocked) {
      return res.status(403).json({ message: "Account is blocked. Contact support." })
    }
    const token = signToken(user)
    res.json({
      token,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isBlocked: user.isBlocked,
        modelPreference: user.modelPreference,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Login failed" })
  }
})

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body
    const user = await User.findOne({ email: email?.toLowerCase() })
    if (!user) {
      return res.json({ message: "If an account exists, a reset email has been sent" })
    }
    const token = crypto.randomBytes(32).toString("hex")
    user.resetPasswordToken = crypto.createHash("sha256").update(token).digest("hex")
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000
    await user.save({ validateBeforeSave: false })

    try {
      await sendPasswordResetEmail(user.email, token)
    } catch (mailErr) {
      console.error("[email] Failed to send reset email:", mailErr.message)
      console.log(`[DEV] Password reset token for ${email}: ${token}`)
    }

    res.json({ message: "If an account exists, a reset email has been sent" })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Request failed" })
  }
})

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ message: "Invalid request" })
    }
    const hashed = crypto.createHash("sha256").update(token).digest("hex")
    const user = await User.findOne({
      resetPasswordToken: hashed,
      resetPasswordExpires: { $gt: Date.now() },
    }).select("+resetPasswordToken +resetPasswordExpires")
    if (!user) {
      return res.status(400).json({ message: "Token invalid or expired" })
    }
    user.password = password
    user.resetPasswordToken = undefined
    user.resetPasswordExpires = undefined
    await user.save()
    res.json({ message: "Password updated successfully" })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: "Reset failed" })
  }
})

router.get("/me", protect, loadUser, (req, res) => {
  res.json({
    _id: req.user._id,
    email: req.user.email,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    role: req.user.role,
    isBlocked: req.user.isBlocked,
    modelPreference: req.user.modelPreference,
    createdAt: req.user.createdAt,
    updatedAt: req.user.updatedAt,
  })
})

router.post("/logout", protect, (req, res) => {
  res.json({ message: "Logged out" })
})

export default router
