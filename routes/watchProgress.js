const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const WatchProgress = require('../models/WatchProgress');
const Movie = require('../models/Movie');

// Update or create watch progress
router.post('/progress', auth, async (req, res) => {
  try {
    const { contentId, contentType, position, duration, episodeNumber, seasonNumber } = req.body;
    
    // Validate required fields
    if (!contentId || !contentType || position === undefined || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate percentage watched
    const percentageWatched = Math.min((position / duration) * 100, 100);

    // Find existing progress or create new
    let progress = await WatchProgress.findOne({
      userId: req.user.id,
      contentId,
      contentType,
      ...(episodeNumber && { episodeNumber }),
      ...(seasonNumber && { seasonNumber })
    });

    if (progress) {
      // Update existing progress
      progress.position = position;
      progress.duration = duration;
      progress.percentageWatched = percentageWatched;
      progress.lastWatched = new Date();
      if (episodeNumber) progress.episodeNumber = episodeNumber;
      if (seasonNumber) progress.seasonNumber = seasonNumber;
    } else {
      // Create new progress
      progress = new WatchProgress({
        userId: req.user.id,
        contentId,
        contentType,
        position,
        duration,
        percentageWatched,
        episodeNumber,
        seasonNumber,
        lastWatched: new Date()
      });
    }

    await progress.save();
    res.json(progress);
  } catch (error) {
    console.error('Error updating watch progress:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get continue watching list
router.get('/continue-watching', auth, async (req, res) => {
  try {
    const progress = await WatchProgress.find({ 
      userId: req.user.id,
      percentageWatched: { $lt: 95 } // Only show items not completed (less than 95% watched)
    })
    .sort({ lastWatched: -1 }) // Most recently watched first
    .limit(10) // Limit to 10 items
    .populate({
      path: 'contentId',
      select: 'title thumbnailUrl type description' // Only select needed fields
    });
    
    // Filter out any items where the content no longer exists
    const validProgress = progress.filter(item => item.contentId != null);
    
    res.json(validProgress);
  } catch (error) {
    console.error('Error fetching continue watching:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get progress for a specific content
router.get('/progress/:contentId', auth, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { episodeNumber, seasonNumber } = req.query;

    const progress = await WatchProgress.findOne({
      userId: req.user.id,
      contentId,
      ...(episodeNumber && { episodeNumber: Number(episodeNumber) }),
      ...(seasonNumber && { seasonNumber: Number(seasonNumber) })
    });

    if (!progress) {
      return res.status(404).json({ message: 'No progress found' });
    }

    res.json(progress);
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete watch progress (useful for testing or user data cleanup)
router.delete('/progress/:contentId', auth, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { episodeNumber, seasonNumber } = req.query;

    const result = await WatchProgress.deleteOne({
      userId: req.user.id,
      contentId,
      ...(episodeNumber && { episodeNumber: Number(episodeNumber) }),
      ...(seasonNumber && { seasonNumber: Number(seasonNumber) })
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'No progress found to delete' });
    }

    res.json({ message: 'Progress deleted successfully' });
  } catch (error) {
    console.error('Error deleting progress:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router; 