const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  rentalId: { type: mongoose.Schema.Types.ObjectId, ref: "Rental", required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  orderId: { type: String, required: true },
  paymentId: String,
  signature: String,
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Payment", paymentSchema); 