const mongoose = require('mongoose');

const watchProgressSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  contentId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Movie", 
    required: true 
  },
  contentType: { 
    type: String, 
    enum: ['movie', 'show', 'episode'], 
    required: true 
  },
  position: { 
    type: Number, 
    required: true,
    min: 0
  }, // Position in seconds
  duration: { 
    type: Number, 
    required: true,
    min: 0
  }, // Total duration in seconds
  percentageWatched: { 
    type: Number, 
    required: true,
    min: 0,
    max: 100
  },
  episodeNumber: { 
    type: Number,
    min: 1
  }, // Only for episodes
  seasonNumber: { 
    type: Number,
    min: 1
  }, // Only for episodes
  lastWatched: { 
    type: Date, 
    default: Date.now,
    required: true
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Create compound index for efficient queries
watchProgressSchema.index({ userId: 1, contentId: 1, contentType: 1 });

// Add validation for episode and season numbers
watchProgressSchema.pre('save', function(next) {
  if (this.contentType === 'episode') {
    if (!this.episodeNumber || !this.seasonNumber) {
      next(new Error('Episode and season numbers are required for episode content type'));
    }
  }
  next();
});

// Update the updatedAt timestamp on save
watchProgressSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('WatchProgress', watchProgressSchema); 