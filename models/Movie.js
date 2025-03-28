const mongoose = require('mongoose');

const episodeSchema = new mongoose.Schema({
  episodeNumber: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String },
  duration: { type: Number },
  hlsUrl: String,
  thumbnailUrl: String,
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  processingProgress: { type: Number, default: 0 }
});

const seasonSchema = new mongoose.Schema({
  seasonNumber: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String },
  episodes: [episodeSchema]
});

const movieSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  description: { type: String },
  type: { type: String, enum: ['movie', 'show'], required: true },
  duration: { type: Number },
  rentalPrice: { type: Number },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  processingProgress: { type: Number, default: 0 },
  hlsUrl: String,
  thumbnailUrl: String,
  trailerUrl: String,
  errorDetails: String,
  seasons: [seasonSchema], // Only used when type is 'show'
  likeCount: { type: Number, default: 0 }, // Track total likes
  watchCount: { type: Number, default: 0 }, // Track total rentals/watches
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Movie', movieSchema); 
