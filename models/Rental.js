const mongoose = require("mongoose");

const rentalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true },
  contentType: { type: String, enum: ['movie', 'show', 'episode'], required: true },
  rentalEnd: { type: Date, required: true },
  status: { type: String, enum: ['active', 'expired'], default: 'active' },
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Rental", rentalSchema); 