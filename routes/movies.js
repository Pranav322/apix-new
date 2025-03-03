const express = require('express');
const router = express.Router();
const Movie = require('../models/Movie');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');
const fs = require('fs').promises;
const path = require('path');
const { WATCH_DIRS } = require('../services/fileManagement');

// Get movie status
router.get("/:id/status", async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) {
      logger.error(`Movie not found: ${req.params.id}`);
      return res.status(404).json({ error: "Movie not found" });
    }
    
    logger.info(`Status requested for content: ${req.params.id}`, {
      status: movie.status,
      progress: movie.processingProgress
    });
    
    if (movie.type === 'show') {
      // Calculate overall show status based on episodes
      let totalEpisodes = 0;
      let completedEpisodes = 0;
      let totalProgress = 0;
      let hasFailedEpisodes = false;

      movie.seasons.forEach(season => {
        season.episodes.forEach(episode => {
          totalEpisodes++;
          totalProgress += episode.processingProgress || 0;
          if (episode.status === 'completed') {
            completedEpisodes++;
          } else if (episode.status === 'failed') {
            hasFailedEpisodes = true;
          }
        });
      });

      // Update show status and progress
      const overallProgress = totalEpisodes > 0 ? Math.round(totalProgress / totalEpisodes) : 0;
      let overallStatus = movie.status;

      if (hasFailedEpisodes) {
        overallStatus = 'failed';
      } else if (completedEpisodes === totalEpisodes) {
        overallStatus = 'completed';
      } else if (completedEpisodes > 0) {
        overallStatus = 'processing';
      }

      // Update the show document if status needs to change
      if (overallStatus !== movie.status) {
        await Movie.findByIdAndUpdate(movie._id, {
          status: overallStatus,
          processingProgress: overallProgress
        });
        logger.info(`Updated show status to ${overallStatus} with progress ${overallProgress}%`);
      }

      res.json({ 
        id: movie._id,
        title: movie.title,
        status: overallStatus,
        processingProgress: overallProgress,
        category: movie.category,
        type: movie.type,
        description: movie.description,
        seasons: movie.seasons.map(season => ({
          seasonNumber: season.seasonNumber,
          title: season.title,
          description: season.description,
          episodes: season.episodes.map(episode => ({
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            status: episode.status,
            processingProgress: episode.processingProgress,
            hlsUrl: episode.hlsUrl,
            thumbnailUrl: episode.thumbnailUrl
          }))
        }))
      });
    } else {
      // For regular movies
      res.json({ 
        id: movie._id,
        title: movie.title,
        status: movie.status,
        processingProgress: movie.processingProgress || 0,
        errorDetails: movie.errorDetails,
        hlsUrl: movie.hlsUrl,
        thumbnailUrl: movie.thumbnailUrl,
        trailerUrl: movie.trailerUrl,
        category: movie.category,
        type: movie.type,
        description: movie.description
      });
    }
  } catch (err) {
    logger.error(`Failed to fetch status: ${req.params.id}`, err);
    res.status(500).json({ error: "Failed to fetch status" });
  }
}); 
// Get all completed movies
router.get("/", async (req, res) => {
  try {
    const { category, type, limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {
      status: 'completed'
    };
    if (category) query.category = category;
    if (type) query.type = type;

    logger.info(`Fetching completed movies with query:`, query);
    logger.info(`Pagination: skip=${skip}, limit=${limit}`);

    const [movies, total] = await Promise.all([
      Movie.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Movie.countDocuments(query)
    ]);

    logger.info(`Found ${movies.length} completed movies out of ${total} total`);

    res.json({
      movies,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logger.error(`Failed to fetch movies: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch movies" });
  }
});

// Get failed movies
router.get("/failed", async (req, res) => {
  try {
    const { category, type, limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {
      status: 'failed'
    };
    if (category) query.category = category;
    if (type) query.type = type;

    logger.info(`Fetching failed movies with query:`, query);

    const [movies, total] = await Promise.all([
      Movie.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Movie.countDocuments(query)
    ]);

    logger.info(`Found ${movies.length} failed movies out of ${total} total`);

    res.json({
      movies,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logger.error(`Failed to fetch failed movies: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch failed movies" });
  }
});

// Get pending/processing movies
router.get("/pending", async (req, res) => {
  try {
    const { category, type, limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {
      status: { $in: ['pending', 'processing'] }
    };
    if (category) query.category = category;
    if (type) query.type = type;

    logger.info(`Fetching pending movies with query:`, query);

    const [movies, total] = await Promise.all([
      Movie.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Movie.countDocuments(query)
    ]);

    logger.info(`Found ${movies.length} pending movies out of ${total} total`);

    res.json({
      movies,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    logger.error(`Failed to fetch pending movies: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch pending movies" });
  }
});

// Search Movies
router.get("/search", async (req, res) => {
  try {
    const { query } = req.query;
    const searchRegex = new RegExp(query, 'i');

    const movies = await Movie.find({
      $or: [
        { title: searchRegex },
        { category: searchRegex }
      ]
    }).lean();

    res.json(movies);
  } catch (err) {
    logger.error("Failed to search movies", err);
    res.status(500).json({ error: "Failed to search movies" });
  }
});

// Delete a movie
router.delete("/:id", authenticateJWT, async (req, res) => {
  try {
    const movieId = req.params.id;
    
    const movie = await Movie.findById(movieId);
    if (!movie) {
      logger.error(`Movie not found for deletion: ${movieId}`);
      return res.status(404).json({ error: "Movie not found" });
    }

    logger.info(`Attempting to delete movie: ${movie.title} (${movieId})`);

    let dirName = '';
    if (movie.hlsUrl) {
      const match = movie.hlsUrl.match(/uploads\/(completed|failed|processing)\/([^\/]+)/);
      if (match) {
        dirName = match[2];
      }
    }

    if (dirName) {
      for (const status of ['completed', 'failed', 'processing']) {
        const dirPath = path.join(WATCH_DIRS[status], dirName);
        if (fsSync.existsSync(dirPath)) {
          logger.info(`Removing directory: ${dirPath}`);
          await fs.rm(dirPath, { recursive: true, force: true });
          logger.success(`Removed ${status} directory for movie: ${dirName}`);
        }
      }
    }

    await Movie.findByIdAndDelete(movieId);
    await Rental.deleteMany({ contentId: movieId });
    await Wishlist.deleteMany({ contentId: movieId });

    logger.success(`Successfully deleted movie: ${movie.title} (${movieId})`);
    res.json({ 
      message: "Movie deleted successfully",
      movieId,
      title: movie.title
    });

  } catch (err) {
    logger.error(`Failed to delete movie: ${err.message}`);
    res.status(500).json({ 
      error: "Failed to delete movie", 
      details: err.message 
    });
  }
});

module.exports = router; 