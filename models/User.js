const mongoose = require("mongoose");

const refreshTokenSchema = new mongoose.Schema({
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  issuedAt: { type: Date, default: Date.now },
  isRevoked: { type: Boolean, default: false }
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  resetPasswordOtp: String,
  resetPasswordExpires: Date,
  refreshTokens: [refreshTokenSchema] // Array to store multiple refresh tokens (for multiple devices)
});

// Method to clean up expired refresh tokens
userSchema.methods.cleanupRefreshTokens = async function() {
  this.refreshTokens = this.refreshTokens.filter(token => 
    !token.isRevoked && token.expiresAt > new Date()
  );
  await this.save();
};

// Method to add a new refresh token
userSchema.methods.addRefreshToken = async function(token, expiresAt) {
  await this.cleanupRefreshTokens();
  this.refreshTokens.push({ token, expiresAt });
  await this.save();
};

// Method to revoke a specific refresh token
userSchema.methods.revokeRefreshToken = async function(token) {
  const tokenDoc = this.refreshTokens.find(t => t.token === token);
  if (tokenDoc) {
    tokenDoc.isRevoked = true;
    await this.save();
  }
};

// Method to revoke all refresh tokens
userSchema.methods.revokeAllRefreshTokens = async function() {
  this.refreshTokens.forEach(token => {
    token.isRevoked = true;
  });
  await this.save();
};

module.exports = mongoose.model("User", userSchema); 