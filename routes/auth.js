const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const transporter = require('../config/email');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');

// User Registration
router.post("/register", async (req, res) => {
  const { username, password, email } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = new User({ username, password: hashedPassword, email });
  await newUser.save();
  res.status(201).json({ message: "User registered successfully" });
});

// User Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

// Get Current User Details
router.get("/me", authenticateJWT, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  res.json(user);
});

// Forgot password endpoint to send OTP
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      logger.warn(`Password reset attempted for non-existent email: ${email}`);
      return res.status(404).json({ error: "User not found" });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordOtp = otp;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Password Reset OTP',
      html: `
        <h2>Password Reset OTP</h2>
        <p>Your OTP for password reset is: <strong>${otp}</strong></p>
        <p>This OTP will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `
    };

    await transporter.sendMail(mailOptions);
    logger.success(`Password reset OTP sent to: ${email}`);
    res.json({ message: "Password reset OTP sent" });

  } catch (err) {
    logger.error("Failed to process forgot password request", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// OTP verification endpoint
router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ 
      email,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      logger.warn(`Invalid or expired OTP verification attempt for email: ${email}`);
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    if (user.resetPasswordOtp !== otp) {
      logger.warn(`Invalid OTP used for email: ${email}`);
      return res.status(400).json({ error: "Invalid OTP" });
    }

    res.json({ message: "OTP verified successfully. You can now set a new password." });

  } catch (err) {
    logger.error("Failed to verify OTP", err);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// Reset password endpoint
router.post("/reset-password", async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      logger.warn(`Password reset attempted for non-existent email: ${email}`);
      return res.status(404).json({ error: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.resetPasswordOtp = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    logger.success(`Password reset successful for user: ${email}`);
    res.json({ message: "Password reset successful" });

  } catch (err) {
    logger.error("Failed to reset password", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

module.exports = router; 