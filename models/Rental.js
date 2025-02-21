const mongoose = require("mongoose");

const rentalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  contentId: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true },
  contentType: { type: String, enum: ['movie', 'show', 'episode'], required: true },
  rentalStart: { type: Date, default: Date.now },
  rentalEnd: { type: Date, required: true },
  status: { type: String, default: 'active' }, // Can be 'active' or 'expired'
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  paymentId: String,
  orderId: String
});

module.exports = mongoose.model("Rental", rentalSchema); 