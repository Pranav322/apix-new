const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');
const Rental = require('../models/Rental');

// Create Payment Order
router.post("/create", authenticateJWT, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      logger.error('Invalid amount for payment order:', amount);
      return res.status(400).json({ error: "Invalid amount" });
    }

    logger.info(`Creating payment order for amount: ${amount}`);

    const shortUserId = req.user.id.slice(-4);
    const timestamp = Date.now().toString().slice(-8);
    const receiptId = `rcpt_${timestamp}_${shortUserId}`;

    const options = {
      amount: Math.round(amount),
      currency: "INR",
      receipt: receiptId,
      payment_capture: 1
    };

    logger.info('Creating order with options:', options);
    
    try {
      const order = await new Promise((resolve, reject) => {
        razorpay.orders.create(options, (err, order) => {
          if (err) {
            logger.error('Razorpay create order error:', err);
            reject(err);
          } else {
            resolve(order);
          }
        });
      });

      logger.success(`Payment order created: ${order.id}`);
      res.json({
        id: order.id,
        amount: order.amount,
        currency: order.currency
      });
    } catch (razorpayError) {
      logger.error('Razorpay error:', razorpayError);
      res.status(500).json({ 
        error: "Failed to create payment order", 
        details: razorpayError.error?.description || razorpayError.message || 'Razorpay error'
      });
    }
  } catch (err) {
    logger.error(`Failed to create payment order: ${err.stack}`);
    res.status(500).json({ 
      error: "Failed to create payment order", 
      details: err.message 
    });
  }
});

// Verify Payment
router.post("/verify", authenticateJWT, async (req, res) => {
  try {
    const { paymentId, orderId, signature, rentalId } = req.body;
    const userId = req.user.id;

    logger.info(`Verifying payment - Order: ${orderId}, Payment: ${paymentId}, User: ${userId}`);
    
    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) {
      logger.error('Razorpay secret key not found in environment variables');
      return res.status(500).json({ error: "Payment verification configuration error" });
    }

    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(orderId + "|" + paymentId)
      .digest('hex');

    if (generatedSignature !== signature) {
      logger.warn(`Invalid payment signature for order: ${orderId}`);
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    await Rental.findByIdAndUpdate(rentalId, { paymentStatus: 'completed' });
    
    logger.success(`Payment verified for order: ${orderId}, user: ${userId}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Payment verification failed: ${err.message}`);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

module.exports = router; 