require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const cors = require('cors');
const Razorpay = require("razorpay");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// Middleware setup
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
const port = process.env.PORT || 5000;

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// Define upload directories
const UPLOAD_DIR = '/home/theapix/public_html/uploads';
const WATCH_DIRS = {
  pending: path.join(UPLOAD_DIR, 'pending'),
  processing: path.join(UPLOAD_DIR, 'processing'),
  completed: path.join(UPLOAD_DIR, 'completed'),
  failed: path.join(UPLOAD_DIR, 'failed')
};

// Create directories if they don't exist
Object.values(WATCH_DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Validate metadata.json and structure
async function validateUploadStructure(uploadDir) {
  try {
    const files = fs.readdirSync(uploadDir);
    if (!files.includes('metadata.json')) {
      throw new Error('metadata.json is required');
    }

    const metadata = JSON.parse(fs.readFileSync(path.join(uploadDir, 'metadata.json')));
    if (!metadata.title || !metadata.category || !metadata.type) {
      throw new Error('Invalid metadata: title, category, and type are required');
    }

    // Verify required files exist
    const requiredFiles = ['video.mp4', 'thumbnail.jpg'];
    for (const file of requiredFiles) {
      if (!files.includes(file)) {
        throw new Error(`Required file ${file} is missing`);
      }
    }

    return metadata;
  } catch (error) {
    throw new Error(`Invalid upload structure: ${error.message}`);
  }
}

// Convert video to HLS
async function convertToHLS(inputPath, outputFolder) {
  return new Promise((resolve, reject) => {
    const hlsPath = path.join(outputFolder, "master.m3u8");
    
    const ffmpegCmd = `
      ffmpeg -i ${inputPath} \
      -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 2000k -bufsize 4000k -vf "scale=1280:720" -c:a aac -ar 48000 -b:a 128k \
      -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/720p_%03d.ts" -hls_playlist_type vod "${outputFolder}/720p.m3u8" \
      -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 1000k -bufsize 2000k -vf "scale=854:480" -c:a aac -ar 48000 -b:a 128k \
      -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/480p_%03d.ts" -hls_playlist_type vod "${outputFolder}/480p.m3u8" \
      -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 600k -bufsize 1200k -vf "scale=640:360" -c:a aac -ar 48000 -b:a 128k \
      -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/360p_%03d.ts" -hls_playlist_type vod "${outputFolder}/360p.m3u8"
    `;
    
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ FFmpeg Error: ${stderr}`);
        reject(error);
        return;
      }
      
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

// Process uploaded directory
async function processUploadedDirectory(dirPath) {
  const dirName = path.basename(dirPath);
  const processingPath = path.join(WATCH_DIRS.processing, dirName);
  
  try {
    // Move to processing directory
    fs.renameSync(dirPath, processingPath);
    
    // Validate structure and get metadata
    const metadata = await validateUploadStructure(processingPath);
    
    // Create movie document
    const movieDoc = new Movie({
      title: metadata.title,
      category: metadata.category,
      description: metadata.description,
      type: metadata.type,
      rentalPrice: metadata.rentalPrice,
      status: 'processing'
    });
    await movieDoc.save();

    // Process video
    const videoPath = path.join(processingPath, 'video.mp4');
    const outputDir = path.join(WATCH_DIRS.completed, dirName, 'video');
    fs.mkdirSync(outputDir, { recursive: true });

    // Convert to HLS
    await convertToHLS(videoPath, outputDir);

    // Update movie document with URLs
    const baseUrl = `https://theapix.in/uploads/completed/${dirName}`;
    await Movie.findByIdAndUpdate(movieDoc._id, {
      hlsUrl: `${baseUrl}/video/master.m3u8`,
      thumbnailUrl: `${baseUrl}/thumbnail.jpg`,
      trailerUrl: fs.existsSync(path.join(processingPath, 'trailer.mp4')) 
        ? `${baseUrl}/trailer.mp4` 
        : null,
      status: 'completed'
    });

    // Move processed files to completed directory
    fs.renameSync(processingPath, path.join(WATCH_DIRS.completed, dirName));
    console.log(`✅ Processing completed for: ${dirName}`);
  } catch (error) {
    console.error(`❌ Processing failed for ${dirName}:`, error);
    
    // Move to failed directory
    if (fs.existsSync(processingPath)) {
      fs.renameSync(processingPath, path.join(WATCH_DIRS.failed, dirName));
    } else if (fs.existsSync(dirPath)) {
      fs.renameSync(dirPath, path.join(WATCH_DIRS.failed, dirName));
    }
    
    // Update movie status if document was created
    if (movieDoc) {
      await Movie.findByIdAndUpdate(movieDoc._id, {
        status: 'failed',
        errorDetails: error.message
      });
    }
  }
}

// Watch for new uploads
const watcher = fs.watch(WATCH_DIRS.pending, { persistent: true });
watcher.on('rename', async (filename) => {
  const uploadPath = path.join(WATCH_DIRS.pending, filename);
  
  // Wait for upload to complete
  setTimeout(async () => {
    if (fs.existsSync(uploadPath)) {
      try {
        const stats = fs.statSync(uploadPath);
        if (stats.isDirectory()) {
          await processUploadedDirectory(uploadPath);
        }
      } catch (error) {
        console.error(`Error processing ${filename}:`, error);
      }
    }
  }, 5000);
});

// Authentication middleware
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

// Keep your existing API endpoints
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

// Start the server
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));