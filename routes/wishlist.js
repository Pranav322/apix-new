const express = require('express');
const router = express.Router();
const Wishlist = require('../models/Wishlist');
const authenticateJWT = require('../middleware/auth');
const logger = require('../config/logger');

// Add to Wishlist
router.post("/:id", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const contentId = req.params.id;

    const existingItem = await Wishlist.findOne({ userId, contentId });
    if (existingItem) {
      logger.warn(`Item already in wishlist: ${contentId}`);
      return res.status(400).json({ error: "Item already in wishlist" });
    }

    const wishlistItem = new Wishlist({ userId, contentId });
    await wishlistItem.save();

    logger.success(`Item added to wishlist: ${contentId}`);
    res.json({ message: "Item added to wishlist", wishlistItem });
  } catch (err) {
    logger.error(`Failed to add to wishlist: ${err.message}`);
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
});

// Remove from Wishlist
router.delete("/:id", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const contentId = req.params.id;

    await Wishlist.findOneAndDelete({ userId, contentId });
    logger.success(`Item removed from wishlist: ${contentId}`);
    res.json({ message: "Item removed from wishlist" });
  } catch (err) {
    logger.error(`Failed to remove from wishlist: ${err.message}`);
    res.status(500).json({ error: "Failed to remove from wishlist" });
  }
});

// Get Wishlist
router.get("/", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    const wishlistItems = await Wishlist.find({ userId }).populate('contentId');
    logger.info(`Retrieved wishlist for user: ${userId}`);
    res.json(wishlistItems);
  } catch (err) {
    logger.error(`Failed to fetch wishlist: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

module.exports = router; 