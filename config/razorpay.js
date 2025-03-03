const Razorpay = require('razorpay');
const logger = require('./logger');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET
});

logger.info(`Razorpay initialized with key: ${process.env.RAZORPAY_KEY_ID}`);

module.exports = razorpay; 