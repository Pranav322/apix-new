require("dotenv").config();
const express = require("express");
const cors = require('cors');
const logger = require('./config/logger');
const connectDB = require('./config/database');
const { initializeDirectories } = require('./services/fileManagement');
const { setupDirectoryWatcher } = require('./services/directoryWatcher');

// Import routes
const authRoutes = require('./routes/auth');
const movieRoutes = require('./routes/movies');
const paymentRoutes = require('./routes/payments');
const rentalRoutes = require('./routes/rentals');
const wishlistRoutes = require('./routes/wishlist');

const app = express();

// Middleware setup
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Initialize directories
initializeDirectories();

// Connect to MongoDB
connectDB();

// Routes
app.use('/auth', authRoutes);
app.use('/movies', movieRoutes);
app.use('/payment', paymentRoutes);
app.use('/purchase', rentalRoutes);
app.use('/wishlist', wishlistRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  const health = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    mongoConnection: mongoose.connection.readyState === 1
  };
  
  logger.info("Health check performed", health);
  res.json(health);
});

// Start directory watcher
setupDirectoryWatcher();

const port = process.env.PORT || 5000;

// Start the server
app.listen(port, () => {
  logger.success(`Server running on http://localhost:${port}`);
});

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  mongoose.connection.close();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
}); 