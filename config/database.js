const mongoose = require('mongoose');
const logger = require('./logger');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    logger.success("Connected to MongoDB");

    // MongoDB connection monitoring
    setInterval(async () => {
      try {
        await mongoose.connection.db.admin().ping();
        logger.info('MongoDB connection alive');
      } catch (error) {
        logger.error('MongoDB connection lost:', error);
      }
    }, 30000);

  } catch (err) {
    logger.error("MongoDB connection error:", err);
    process.exit(1);
  }
};

module.exports = connectDB; 