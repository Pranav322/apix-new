require("dotenv").config();
const express = require("express");
const cors = require('cors');
const logger = require('./config/logger');
const connectDB = require('./config/database');
const { initializeDirectories } = require('./services/fileManagement');
const { setupDirectoryWatcher } = require('./services/directoryWatcher');
const authenticateJWT = require('./middleware/auth');
const Rental = require('./models/Rental');
const Movie = require('./models/Movie');

// Import routes
const authRoutes = require('./routes/auth');
const movieRoutes = require('./routes/movies');
const paymentRoutes = require('./routes/payments');
const rentalRoutes = require('./routes/rentals');
const wishlistRoutes = require('./routes/wishlist');
const watchProgressRoutes = require('./routes/watchProgress');

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
app.use('/watch-progress', watchProgressRoutes);

// Direct streaming route to match frontend
app.get('/stream/:id', authenticateJWT, async (req, res) => {
  try {
    const contentId = req.params.id;
    const userId = req.user.id;
    const { seasonNumber, episodeNumber } = req.query;

    logger.info(`Stream request - Content: ${contentId}, User: ${userId}, Season: ${seasonNumber}, Episode: ${episodeNumber}`);

    // Check if user has an active rental
    const rental = await Rental.findOne({
      userId,
      contentId,
      status: 'active',
      rentalEnd: { $gt: new Date() },
      paymentStatus: 'completed'
    });

    if (!rental) {
      logger.warn(`Unauthorized streaming attempt for content: ${contentId}, user: ${userId}`);
      return res.status(403).json({ error: "Access denied. Rental has expired, not paid, or does not exist." });
    }

    const content = await Movie.findById(contentId);
    if (!content) {
      logger.error(`Content not found: ${contentId}`);
      return res.status(404).json({ error: "Content not found" });
    }

    // Handle different content types
    if (content.type === 'show') {
      if (rental.contentType === 'show') {
        // If renting the whole show, return all episodes
        if (!seasonNumber && !episodeNumber) {
          // Return all seasons and episodes with streaming URLs
          const showData = {
            id: content._id,
            title: content.title,
            type: content.type,
            streamingUrl: content.seasons[0].episodes[0].hlsUrl, // Default to first episode
            thumbnailUrl: content.seasons[0].episodes[0].thumbnailUrl
          };
          
          logger.info(`Streaming show content: ${contentId} for user: ${userId}`);
          return res.json(showData);
        } 
        // Return specific episode
        else if (seasonNumber && episodeNumber) {
          const season = content.seasons.find(s => s.seasonNumber === parseInt(seasonNumber));
          if (!season) {
            logger.error(`Season ${seasonNumber} not found for show: ${contentId}`);
            return res.status(404).json({ error: "Season not found" });
          }

          const episode = season.episodes.find(e => e.episodeNumber === parseInt(episodeNumber));
          if (!episode) {
            logger.error(`Episode ${episodeNumber} not found for season ${seasonNumber} of show: ${contentId}`);
            return res.status(404).json({ error: "Episode not found" });
          }

          logger.info(`Streaming episode ${episodeNumber} of season ${seasonNumber} for show: ${contentId}`);
          return res.json({
            id: content._id,
            title: content.title,
            streamingUrl: episode.hlsUrl,
            thumbnailUrl: episode.thumbnailUrl
          });
        }
      }
    } else {
      // Regular movie
      logger.info(`Streaming movie: ${contentId} for user: ${userId}`);
      res.json({ 
        id: content._id,
        title: content.title,
        streamingUrl: content.hlsUrl,
        thumbnailUrl: content.thumbnailUrl
      });
    }
  } catch (err) {
    logger.error(`Failed to stream content: ${err.message}`);
    res.status(500).json({ error: "Failed to stream content" });
  }
});

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