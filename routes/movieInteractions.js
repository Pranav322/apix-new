const express = require('express');
const router = express.Router();
const Movie = require('../models/Movie');
const MovieLike = require('../models/MovieLike');
const Rental = require('../models/Rental');
const authenticateJWT = require('../middleware/auth');

// Toggle like for a movie
router.post('/:movieId/like', authenticateJWT, async (req, res) => {
    try {
        const { movieId } = req.params;
        const userId = req.user.id;

        // Check if user has already liked this movie
        const existingLike = await MovieLike.findOne({ userId, movieId });

        if (existingLike) {
            // Unlike: Remove the like and decrease count
            await MovieLike.deleteOne({ _id: existingLike._id });
            await Movie.findByIdAndUpdate(movieId, { $inc: { likeCount: -1 } });
            return res.json({ liked: false, message: 'Movie unliked successfully' });
        } else {
            // Like: Add new like and increase count
            const newLike = new MovieLike({ userId, movieId });
            await newLike.save();
            await Movie.findByIdAndUpdate(movieId, { $inc: { likeCount: 1 } });
            return res.json({ liked: true, message: 'Movie liked successfully' });
        }
    } catch (error) {
        console.error('Error in like toggle:', error);
        res.status(500).json({ error: 'Failed to toggle like' });
    }
});

// Get movie stats and user's interaction status
router.get('/:movieId/stats', authenticateJWT, async (req, res) => {
    try {
        const { movieId } = req.params;
        const userId = req.user.id;

        // Get movie details with like and watch counts
        const movie = await Movie.findById(movieId).select('likeCount watchCount');
        
        // Check if user has liked this movie
        const userLike = await MovieLike.findOne({ userId, movieId });
        
        // Get user's rental/watch history for this movie
        const userRentals = await Rental.find({ 
            userId, 
            contentId: movieId,
            status: 'active'
        }).countDocuments();

        res.json({
            stats: {
                likeCount: movie.likeCount,
                watchCount: movie.watchCount,
                userHasLiked: !!userLike,
                userActiveRentals: userRentals
            }
        });
    } catch (error) {
        console.error('Error fetching movie stats:', error);
        res.status(500).json({ error: 'Failed to fetch movie statistics' });
    }
});

module.exports = router; 