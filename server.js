require("dotenv").config();
const express = require("express");
const multer = require("multer");
const SFTPClient = require("ssh2-sftp-client");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const stream = require('stream');
const cors = require('cors');
const Razorpay = require("razorpay");
const crypto = require('crypto');
const app = express();
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
const port = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const movieSchema = new mongoose.Schema({
  title: String,
  category: String,
  description: String,
  hlsUrl: String,
  trailerUrl: String,
  thumbnailUrl: String,
  uploadDate: { type: Date, default: Date.now },
  status: { type: String, default: 'processing' },
  type: { type: String, enum: ['movie', 'show'], required: true },
  rentalPrice: { type: Number, required: function() { return this.type === 'movie' || this.type === 'show'; } }, // Rental price for the whole show
  rentalDuration: { type: Number, default: 48 }, // Duration in hours for rental
  seasons: [{ // Array to hold seasons for shows
    seasonNumber: { type: Number, required: true },
    rentalPrice: { type: Number, required: true }, // Rental price for the season
    episodes: [{
      title: String,
      description: String,
      hlsUrl: String,
      thumbnailUrl: String,
      uploadDate: { type: Date, default: Date.now },
      status: { type: String, default: 'processing' },
      rentalPrice: { type: Number, required: true } // Rental price for the episode
    }]
  }]
});

const Movie = mongoose.model("Movie", movieSchema);

const User = require("./models/User");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Rental = require("./models/Rental");
const Wishlist = require("./models/Wishlist");

// Middleware to authenticate JWT
const authenticateJWT = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.sendStatus(403);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// User Registration
app.post("/auth/register", async (req, res) => {
  const { username, password, email } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = new User({ username, password: hashedPassword, email });
  await newUser.save();
  res.status(201).json({ message: "User registered successfully" });
});

// User Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
  res.json({ token });
});

// Get Current User Details
app.get("/auth/me", authenticateJWT, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  res.json(user);
});

// Logout (optional, just for client-side token management)
app.post("/auth/logout", (req, res) => {
  // Handle logout on client-side by removing the token
  res.json({ message: "Logged out successfully" });
});

// Use disk storage instead of memory storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const tempDir = path.join('/tmp', 'uploads', new Date().toISOString().replace(/:/g, '-'));
    fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

// Set file size limits
const upload = multer({ 
  storage,
  limits: { fileSize: 15 * 1024 * 1024 * 1024 } // 15GB limit
});

const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: 22,
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
  readyTimeout: 120000, // 2 minutes
  keepaliveInterval: 20000, // Send keepalive packets every 20s
  keepaliveCountMax: 10, // Retry 10 times before disconnecting
};

const outputDir = '/tmp/hls_output';

// Ensure the directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

async function convertToHLS(inputPath, outputFolder) {
  return new Promise((resolve, reject) => {
    // Create quality variants for adaptive streaming
    const hlsPath = path.join(outputFolder, "master.m3u8");
    
    // Enhanced ffmpeg command with multiple quality renditions
    const ffmpegCmd = `
      ffmpeg -i ${inputPath} \
  -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 2000k -bufsize 4000k -vf "scale=1280:720" -c:a aac -ar 48000 -b:a 128k \
  -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/720p_%03d.ts" -hls_playlist_type vod "${outputFolder}/720p.m3u8" \
  -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 1000k -bufsize 2000k -vf "scale=854:480" -c:a aac -ar 48000 -b:a 128k \
  -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/480p_%03d.ts" -hls_playlist_type vod "${outputFolder}/480p.m3u8" \
  -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 600k -bufsize 1200k -vf "scale=640:360" -c:a aac -ar 48000 -b:a 128k \
  -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/360p_%03d.ts" -hls_playlist_type vod "${outputFolder}/360p.m3u8"

    `;
    
    // Create master playlist
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ FFmpeg Error: ${stderr}`);
        reject(error);
        return;
      }
      
      // Create master playlist file
      const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2128000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1128000,RESOLUTION=854x480
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=728000,RESOLUTION=640x360
360p.m3u8`;
      
      fs.writeFileSync(hlsPath, masterContent);
      console.log(`✅ HLS Conversion Complete: ${hlsPath}`);
      resolve(hlsPath);
    });
  });
}

// Stream-based SFTP upload
async function uploadToSFTP(sftp, localPath, remotePath) {
  try {
    // Check if it's a directory
    const stats = fs.statSync(localPath);
    if (stats.isDirectory()) {
      const files = fs.readdirSync(localPath);
      for (const file of files) {
        await uploadToSFTP(sftp, path.join(localPath, file), `${remotePath}/${file}`);
      }
      return `https://theapix.in${remotePath.replace("/home/theapix/public_html", "")}`;
    }
    
    // Create remote directory if needed
    const remoteDir = path.dirname(remotePath);
    await sftp.mkdir(remoteDir, true);
    
    // Use streaming for file uploads
    const readStream = fs.createReadStream(localPath);
    await sftp.put(readStream, remotePath);
    console.log(`✅ Uploaded: ${remotePath}`);
    return `https://theapix.in${remotePath.replace("/home/theapix/public_html", "")}`;
  } catch (err) {
    console.error(`❌ SFTP Upload Error: ${err}`);
    throw err;
  }
}

// Initialize upload process and return immediately
app.post("/upload", upload.fields([
  { name: "video" }, 
  { name: "trailer" }, 
  { name: "thumbnail" }
]), async (req, res) => {
  const { title, category, description, type, rentalPrice, seasons } = req.body;

  if (!title || !category || !type) {
    return res.status(400).json({ error: "Title, category, and type are required" });
  }

  if (type === 'movie') {
    if (!rentalPrice) {
      return res.status(400).json({ error: "Rental price is required for movies" });
    }
    if (seasons) {
      return res.status(400).json({ error: "Seasons should not be provided for movies" });
    }
  } else if (type === 'show') {
    if (!seasons || seasons.length === 0) {
      return res.status(400).json({ error: "Seasons are required for shows" });
    }
    // Validate rental prices for seasons and episodes
    for (const season of seasons) {
      if (!season.rentalPrice) {
        return res.status(400).json({ error: "Rental price is required for each season" });
      }
      for (const episode of season.episodes) {
        if (!episode.rentalPrice) {
          return res.status(400).json({ error: "Rental price is required for each episode" });
        }
      }
    }
  }

  // Create movie document immediately with processing status
  const newMovie = new Movie({ 
    title, 
    category, 
    description, 
    type, 
    rentalPrice: type === 'movie' ? rentalPrice : undefined, // Set rental price only for movies
    seasons: type === 'show' ? seasons : undefined, // Set seasons only for shows
    status: 'processing'
  });

  await newMovie.save();

  // Return response immediately
  res.json({ 
    message: "Upload processing started", 
    movieId: newMovie._id,
    status: 'processing'
  });

  // Process files in background
  processUploadedFiles(req.files, newMovie, category, title).catch(err => {
    console.error("Background processing error:", err);
    updateMovieStatus(newMovie._id, 'failed', err.message);
  });
});

// Background processing function
async function processUploadedFiles(files, movieDoc, category, title) {
  const movieId = movieDoc._id;
  const movieFolder = `/home/theapix/public_html/movies/${category}/${title}/`;
  const sftp = new SFTPClient();

  try {
    await sftp.connect(sftpConfig);
    await sftp.mkdir(movieFolder, true);
    
    let hlsUrl = null;
    let trailerUrl = null;
    let thumbnailUrl = null;

    // Process main video if provided
    if (files["video"]) {
      const videoPath = files["video"][0].path;
      const videoOutputDir = path.join(outputDir, movieId.toString());
      
      if (!fs.existsSync(videoOutputDir)) {
        fs.mkdirSync(videoOutputDir, { recursive: true });
      }
      
      await updateMovieStatus(movieId, 'converting');
      await convertToHLS(videoPath, videoOutputDir);
      
      await updateMovieStatus(movieId, 'uploading');
      await sftp.mkdir(`${movieFolder}video`, true);
      
      // Upload all HLS files
      await uploadToSFTP(sftp, videoOutputDir, `${movieFolder}video`);
      hlsUrl = `https://theapix.in/movies/${category}/${title}/video/master.m3u8`;
      
      // Clean up temp files
      fs.rmSync(videoOutputDir, { recursive: true, force: true });
      fs.rmSync(videoPath, { force: true });
    }

    // Process trailer if provided
    if (files["trailer"]) {
      await sftp.mkdir(`${movieFolder}trailer`, true);
      const trailerPath = files["trailer"][0].path;
      trailerUrl = await uploadToSFTP(
        sftp, 
        trailerPath, 
        `${movieFolder}trailer/${path.basename(trailerPath)}`
      );
      fs.rmSync(trailerPath, { force: true });
    }

    // Process thumbnail if provided
    if (files["thumbnail"]) {
      await sftp.mkdir(`${movieFolder}thumbnail`, true);
      const thumbnailPath = files["thumbnail"][0].path;
      thumbnailUrl = await uploadToSFTP(
        sftp, 
        thumbnailPath, 
        `${movieFolder}thumbnail/${path.basename(thumbnailPath)}`
      );
      fs.rmSync(thumbnailPath, { force: true });
    }

    // Process episodes if the type is a show
    if (movieDoc.type === 'show' && movieDoc.seasons) {
      for (const season of movieDoc.seasons) {
        for (const episode of season.episodes) {
          // Process each episode (uploading logic here)
          // You can create a similar upload logic for episodes as done for the main video
        }
      }
    }

    await sftp.end();

    // Update movie document with final URLs
    await Movie.findByIdAndUpdate(movieId, {
      hlsUrl,
      trailerUrl,
      thumbnailUrl,
      status: 'completed'
    });
    
    console.log(`✅ Processing completed for movie/show: ${title}`);
  } catch (err) {
    console.error(`❌ Processing failed: ${err.message}`);
    await updateMovieStatus(movieId, 'failed', err.message);
    throw err;
  }
}

async function updateMovieStatus(movieId, status, errorDetails = null) {
  const updateData = { status };
  if (errorDetails) {
    updateData.errorDetails = errorDetails;
  }
  await Movie.findByIdAndUpdate(movieId, updateData);
}

// Get movie status endpoint
app.get("/movies/:id/status", async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) {
      return res.status(404).json({ error: "Movie not found" });
    }
    res.json({ 
      id: movie._id,
      title: movie.title,
      status: movie.status,
      errorDetails: movie.errorDetails,
      hlsUrl: movie.hlsUrl
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch movie status" });
  }
});

// Get Movies Endpoint
app.get("/movies", async (req, res) => {
  try {
    const { category, type, limit = 20, page = 1 } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (category) query.category = category;
    if (type) query.type = type; // Filter by type

    const [movies, total] = await Promise.all([
      Movie.find(query)
        .sort({ uploadDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Movie.countDocuments(query)
    ]);

    res.json({
      movies,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch movies" });
  }
});

// Search Movies Endpoint
app.get("/movies/search", async (req, res) => {
  try {
    const { query } = req.query; // Get the search query from the request
    const searchRegex = new RegExp(query, 'i'); // Create a case-insensitive regex for searching

    const movies = await Movie.find({
      $or: [
        { title: searchRegex }, // Search by title
        { category: searchRegex } // Search by category
      ]
    }).lean();

    res.json(movies);
  } catch (err) {
    res.status(500).json({ error: "Failed to search movies" });
  }
});

// Rent a Movie
app.post("/purchase/movie/:id", authenticateJWT, async (req, res) => {
  try {
    const movieId = req.params.id;
    const userId = req.user.id;

    // Find the movie
    const movie = await Movie.findById(movieId);
    if (!movie) {
      return res.status(404).json({ error: "Movie not found" });
    }

    // Calculate rental expiration (48 hours from now)
    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    // Create a new rental record
    const rental = new Rental({
      userId,
      contentId: movieId,
      contentType: 'movie',
      rentalEnd,
      paymentStatus: 'completed'
    });

    await rental.save();

    res.json({ 
      message: "Movie rented successfully", 
      rental,
      streamingUrl: movie.hlsUrl
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to rent movie" });
  }
});

// Get Active Rentals
app.get("/purchase/active", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find active rentals for the user
    const activeRentals = await Rental.find({
      userId,
      rentalEnd: { $gt: new Date() } // Only include rentals that have not expired
    }).populate('contentId'); // Populate the contentId to get movie/show details

    res.json(activeRentals);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch active rentals" });
  }
});

// Rent a Show
app.post("/purchase/show/:id", authenticateJWT, async (req, res) => {
  try {
    const showId = req.params.id;
    const userId = req.user.id;

    // Find the show
    const show = await Movie.findById(showId);
    if (!show || show.type !== 'show') {
      return res.status(404).json({ error: "Show not found" });
    }

    // Calculate rental expiration (48 hours from now)
    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    // Create a new rental record
    const rental = new Rental({
      userId,
      contentId: showId,
      contentType: 'show',
      rentalEnd
    });

    await rental.save();

    res.json({ message: "Show rented successfully", rental });
  } catch (err) {
    res.status(500).json({ error: "Failed to rent show" });
  }
});

// Rent an Episode
app.post("/purchase/show/:id/season/:seasonNumber/episode/:episodeNumber", authenticateJWT, async (req, res) => {
  try {
    const showId = req.params.id;
    const seasonNumber = req.params.seasonNumber;
    const episodeNumber = req.params.episodeNumber;
    const userId = req.user.id;

    // Find the show
    const show = await Movie.findById(showId);
    if (!show || show.type !== 'show') {
      return res.status(404).json({ error: "Show not found" });
    }

    // Find the specific season
    const season = show.seasons.find(s => s.seasonNumber === parseInt(seasonNumber));
    if (!season) {
      return res.status(404).json({ error: "Season not found" });
    }

    // Find the specific episode
    const episode = season.episodes[episodeNumber - 1]; // Assuming episode numbers start from 1
    if (!episode) {
      return res.status(404).json({ error: "Episode not found" });
    }

    // Calculate rental expiration (48 hours from now)
    const rentalEnd = new Date();
    rentalEnd.setHours(rentalEnd.getHours() + 48);

    // Create a new rental record
    const rental = new Rental({
      userId,
      contentId: showId,
      contentType: 'episode',
      rentalEnd
    });

    await rental.save();

    res.json({ message: "Episode rented successfully", rental });
  } catch (err) {
    res.status(500).json({ error: "Failed to rent episode" });
  }
});

// Stream Content
app.get("/stream/:id", authenticateJWT, async (req, res) => {
  try {
    const contentId = req.params.id;
    const userId = req.user.id;

    // Find the rental record for the user
    const rental = await Rental.findOne({
      userId,
      contentId,
      rentalEnd: { $gt: new Date() } // Check if the rental is still active
    });

    if (!rental) {
      return res.status(403).json({ error: "Access denied. Rental has expired or does not exist." });
    }

    // Find the content (movie or show)
    const content = await Movie.findById(contentId);
    if (!content) {
      return res.status(404).json({ error: "Content not found" });
    }

    // Return the streaming URL (assuming hlsUrl is the streaming link)
    res.json({ streamingUrl: content.hlsUrl });
  } catch (err) {
    res.status(500).json({ error: "Failed to stream content" });
  }
});

// Get User Purchase History
app.get("/purchase/history", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all rentals for the user
    const rentals = await Rental.find({ userId })
      .populate('contentId') // Populate the contentId to get movie/show details
      .sort({ rentalStart: -1 }); // Sort by rental start time

    // Format the response to include rental time
    const purchaseHistory = rentals.map(rental => ({
      rentalId: rental._id,
      contentId: rental.contentId._id,
      title: rental.contentId.title,
      rentalStart: rental.rentalStart,
      rentalEnd: rental.rentalEnd,
      status: rental.status,
      contentType: rental.contentType
    }));

    res.json(purchaseHistory);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch purchase history" });
  }
});

// Add to Wishlist
app.post("/wishlist/:id", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const contentId = req.params.id;

    // Check if the item is already in the wishlist
    const existingItem = await Wishlist.findOne({ userId, contentId });
    if (existingItem) {
      return res.status(400).json({ error: "Item already in wishlist" });
    }

    // Create a new wishlist item
    const wishlistItem = new Wishlist({ userId, contentId });
    await wishlistItem.save();

    res.json({ message: "Item added to wishlist", wishlistItem });
  } catch (err) {
    res.status(500).json({ error: "Failed to add to wishlist" });
  }
});

// Remove from Wishlist
app.delete("/wishlist/:id", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const contentId = req.params.id;

    // Remove the item from the wishlist
    await Wishlist.findOneAndDelete({ userId, contentId });

    res.json({ message: "Item removed from wishlist" });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove from wishlist" });
  }
});

// Get Wishlist
app.get("/wishlist", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all wishlist items for the user
    const wishlistItems = await Wishlist.find({ userId }).populate('contentId');

    res.json(wishlistItems);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID, // Your Razorpay key ID
  key_secret: process.env.RAZORPAY_KEY_SECRET // Your Razorpay key secret
});

// Create Payment Order
app.post("/payment/create", authenticateJWT, async (req, res) => {
  const { amount } = req.body; // Amount should be in paise (e.g., 5000 for ₹50)

  const options = {
    amount, // Amount in paise
    currency: "INR",
    receipt: `receipt_order_${new Date().getTime()}`,
  };

  try {
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Failed to create payment order" });
  }
});

// Verify Payment
app.post("/payment/verify", async (req, res) => {
  const { paymentId, orderId, signature, userId, rentalId } = req.body;

  const generatedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(orderId + "|" + paymentId)
    .digest('hex');

  if (generatedSignature === signature) {
    try {
      // Create a new payment record
      const payment = new Payment({
        userId,
        rentalId,
        amount: req.body.amount, // Ensure you pass the amount from the frontend
        paymentId,
        orderId,
        status: 'completed'
      });
      await payment.save();

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to create payment record" });
    }
  } else {
    res.status(400).json({ error: "Payment verification failed" });
  }
});

// Start the server
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));