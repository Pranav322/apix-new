const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const transporter = require('../config/email');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');
const crypto = require('crypto');

// Helper function to generate tokens
const generateTokens = async (user) => {
  // Generate access token (short-lived)
  const accessToken = jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: '15m' } // Shorter expiry for access token
  );

  // Generate refresh token (long-lived)
  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshTokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  // Save refresh token to user
  await user.addRefreshToken(refreshToken, refreshTokenExpiry);

  return {
    accessToken,
    refreshToken,
    refreshTokenExpiry
  };
};

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
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const tokens = await generateTokens(user);

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id,
        email: user.email,
        username: user.username
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Refresh Token endpoint
router.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token is required" });
    }

    // Find user with this refresh token
    const user = await User.findOne({
      'refreshTokens.token': refreshToken,
      'refreshTokens.isRevoked': false,
      'refreshTokens.expiresAt': { $gt: new Date() }
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    // Revoke the old refresh token
    await user.revokeRefreshToken(refreshToken);

    // Generate new tokens
    const tokens = await generateTokens(user);

    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    logger.error('Refresh token error:', error);
    res.status(500).json({ error: "Token refresh failed" });
  }
});

// Logout endpoint
router.post("/logout", authenticateJWT, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await User.findById(req.user.id);

    if (user && refreshToken) {
      // Revoke specific refresh token
      await user.revokeRefreshToken(refreshToken);
    }

    res.json({ message: "Logged out successfully" });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: "Logout failed" });
  }
});

// Logout from all devices
router.post("/logout-all", authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user) {
      await user.revokeAllRefreshTokens();
    }
    res.json({ message: "Logged out from all devices" });
  } catch (error) {
    logger.error('Logout all error:', error);
    res.status(500).json({ error: "Logout from all devices failed" });
  }
});

// Get Current User Details
router.get("/me", authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password -refreshTokens");
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: "Failed to fetch user details" });
  }
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