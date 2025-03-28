const mongoose = require('mongoose');

const movieLikeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  movieId: { type: mongoose.Schema.Types.ObjectId, ref: "Movie", required: true },
  createdAt: { type: Date, default: Date.now }
});

// Add unique compound index to prevent duplicate likes
movieLikeSchema.index({ userId: 1, movieId: 1 }, { unique: true });

module.exports = mongoose.model('MovieLike', movieLikeSchema); 