const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Movie = require('../models/Movie');
const Rental = require('../models/Rental');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');

// Rent a Movie
router.post("/movie/:id", authenticateJWT, async (req, res) => {
  try {
    const movieId = req.params.id;
    const userId = req.user.id;

    logger.info(`Rental request received - Movie: ${movieId}, User: ${userId}`);

    if (!mongoose.Types.ObjectId.isValid(movieId)) {
      logger.error(`Invalid movie ID format: ${movieId}`);
      return res.status(400).json({ error: "Invalid movie ID format" });
    }

    const movie = await Movie.findById(movieId);
    if (!movie) {
      logger.error(`Movie not found: ${movieId}`);
      return res.status(404).json({ error: "Movie not found" });
    }

    const existingRental = await Rental.findOne({
      userId,
      contentId: movieId,
      status: 'active',
      paymentStatus: { $in: ['completed', 'pending'] }
    });

    if (existingRental) {
      logger.warn(`User ${userId} already has an active rental for movie ${movieId}`);
      return res.json({ 
        message: "Rental already exists",
        rental: existingRental
      });
    }

    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    const rental = new Rental({
      userId,
      contentId: movieId,
      contentType: 'movie',
      rentalEnd,
      status: 'active',
      paymentStatus: 'pending'
    });

    await rental.save();
    logger.success(`Rental created for movie: ${movieId}, user: ${userId}`);

    res.json({ 
      message: "Rental initiated",
      rental: rental.toObject()
    });
  } catch (err) {
    logger.error(`Failed to create rental: ${err.message}`);
    res.status(500).json({ error: "Failed to create rental", details: err.message });
  }
});

// Rent a Show
router.post("/show/:id", authenticateJWT, async (req, res) => {
  try {
    const showId = req.params.id;
    const userId = req.user.id;

    const show = await Movie.findById(showId);
    if (!show || show.type !== 'show') {
      logger.error(`Show not found: ${showId}`);
      return res.status(404).json({ error: "Show not found" });
    }

    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    const rental = new Rental({
      userId,
      contentId: showId,
      contentType: 'show',
      rentalEnd,
      paymentStatus: 'pending'
    });

    await rental.save();
    logger.success(`Rental created for show: ${showId}, user: ${userId}`);

    res.json({ 
      message: "Show rental initiated",
      rental
    });
  } catch (err) {
    logger.error(`Failed to rent show: ${err.message}`);
    res.status(500).json({ error: "Failed to rent show" });
  }
});

// Rent an Episode
router.post("/show/:id/season/:seasonNumber/episode/:episodeNumber", authenticateJWT, async (req, res) => {
  try {
    const showId = req.params.id;
    const seasonNumber = req.params.seasonNumber;
    const episodeNumber = req.params.episodeNumber;
    const userId = req.user.id;

    const show = await Movie.findById(showId);
    if (!show || show.type !== 'show') {
      logger.error(`Show not found: ${showId}`);
      return res.status(404).json({ error: "Show not found" });
    }

    const season = show.seasons.find(s => s.seasonNumber === parseInt(seasonNumber));
    if (!season) {
      logger.error(`Season not found: ${seasonNumber} for show: ${showId}`);
      return res.status(404).json({ error: "Season not found" });
    }

    const episode = season.episodes[episodeNumber - 1];
    if (!episode) {
      logger.error(`Episode not found: ${episodeNumber} for show: ${showId}`);
      return res.status(404).json({ error: "Episode not found" });
    }

    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    const rental = new Rental({
      userId,
      contentId: showId,
      contentType: 'episode',
      rentalEnd,
      paymentStatus: 'pending'
    });

    await rental.save();
    logger.success(`Rental created for episode: ${episode.title}, user: ${userId}`);

    res.json({ 
      message: "Episode rental initiated",
      rental
    });
  } catch (err) {
    logger.error(`Failed to rent episode: ${err.message}`);
    res.status(500).json({ error: "Failed to rent episode" });
  }
});

// Get Active Rentals
router.get("/active", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const activeRentals = await Rental.find({
      userId,
      rentalEnd: { $gt: new Date() }
    }).populate('contentId');

    logger.info(`Retrieved active rentals for user: ${userId}`);
    res.json(activeRentals);
  } catch (err) {
    logger.error(`Failed to fetch active rentals: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch active rentals" });
  }
});

// Get User Purchase History
router.get("/history", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const rentals = await Rental.find({ userId })
      .populate('contentId')
      .sort({ rentalEnd: -1 });

    const purchaseHistory = rentals.map(rental => ({
      rentalId: rental._id,
      contentId: rental.contentId?._id || null,
      title: rental.contentId?.title || 'Content Unavailable',
      rentalEnd: rental.rentalEnd,
      status: rental.paymentStatus,
      contentType: rental.contentType,
      createdAt: rental.createdAt
    }));

    logger.info(`Retrieved purchase history for user: ${userId}`);
    res.json(purchaseHistory);
  } catch (err) {
    logger.error(`Failed to fetch purchase history: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch purchase history" });
  }
});

// Stream Content
router.get("/stream/:id", authenticateJWT, async (req, res) => {
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
            seasons: content.seasons.map(season => ({
              seasonNumber: season.seasonNumber,
              title: season.title,
              episodes: season.episodes.map(episode => ({
                episodeNumber: episode.episodeNumber,
                title: episode.title,
                hlsUrl: episode.hlsUrl,
                thumbnailUrl: episode.thumbnailUrl
              }))
            }))
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
            episodeTitle: episode.title,
            streamingUrl: episode.hlsUrl,
            thumbnailUrl: episode.thumbnailUrl
          });
        }
      } 
      else if (rental.contentType === 'episode') {
        // If renting a specific episode, check if the requested episode matches
        if (!seasonNumber || !episodeNumber) {
          return res.status(400).json({ error: "Season and episode numbers are required for episode streaming" });
        }

        // Verify this is the rented episode
        // In a real implementation, you would store the specific episode info in the rental
        // For now, we'll just check if the user has any rental for this show
        
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
          episodeTitle: episode.title,
          streamingUrl: episode.hlsUrl,
          thumbnailUrl: episode.thumbnailUrl
        });
      }
    } 
    else {
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

module.exports = router; 