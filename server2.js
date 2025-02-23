require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { exec } = require("child_process");
const cors = require('cors');
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

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
const authenticateJWT = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.sendStatus(403);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ... existing code ...

// const User = require("./models/User"); // Ensure this is included
// const bcrypt = require("bcryptjs");
// const jwt = require("jsonwebtoken");

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

// ... existing code ...

// MongoDB Models
const movieSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  description: { type: String },
  type: { type: String, required: true },
  rentalPrice: { type: Number },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  processingProgress: { type: Number, default: 0 },
  hlsUrl: String,
  thumbnailUrl: String,
  trailerUrl: String,
  errorDetails: String,
  createdAt: { type: Date, default: Date.now }
});

const Movie = mongoose.model('Movie', movieSchema);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  resetPasswordOtp: String,
  resetPasswordExpires: Date
});

const User = mongoose.model('User', userSchema);

// Enhanced Logger
const logger = {
  info: (message, data = '') => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ℹ️ ${message}`, data);
  },
  success: (message, data = '') => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ✅ ${message}`, data);
  },
  error: (message, error = '') => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ❌ ${message}`, error);
  },
  warn: (message, data = '') => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] ⚠️ ${message}`, data);
  }
};

// MongoDB connection with enhanced monitoring
mongoose
  .connect(process.env.MONGO_URI, { 
    useNewUrlParser: true,
    useUnifiedTopology: true
  })
  .then(() => logger.success("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err));

// MongoDB connection monitoring
setInterval(async () => {
  try {
    await mongoose.connection.db.admin().ping();
    logger.info('MongoDB connection alive');
  } catch (error) {
    logger.error('MongoDB connection lost:', error);
  }
}, 30000);

// Define upload directories
const UPLOAD_DIR = '/home/theapix/public_html/uploads';
const WATCH_DIRS = {
  pending: path.join(UPLOAD_DIR, 'pending'),
  processing: path.join(UPLOAD_DIR, 'processing'),
  completed: path.join(UPLOAD_DIR, 'completed'),
  failed: path.join(UPLOAD_DIR, 'failed')
};

// Directory setup and permission checks
Object.values(WATCH_DIRS).forEach(dir => {
  try {
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.chmodSync(dir, '0755');
      logger.success(`Created directory with permissions: ${dir}`);
    }
    
    // Test write permissions
    const testFile = path.join(dir, '.test');
    fsSync.writeFileSync(testFile, 'test');
    fsSync.unlinkSync(testFile);
    logger.success(`Directory ${dir} is writable`);
  } catch (error) {
    logger.error(`Permission error for ${dir}:`, error);
  }
});

// Validate metadata.json and structure
async function validateUploadStructure(uploadDir) {
  try {
    logger.info(`Validating upload structure for: ${uploadDir}`);
    const files = await fs.readdir(uploadDir);
    logger.info(`Found files:`, files);
    
    if (!files.includes('metadata.json')) {
      throw new Error('metadata.json is required');
    }

    const metadataPath = path.join(uploadDir, 'metadata.json');
    const metadataContent = await fs.readFile(metadataPath, 'utf8');
    logger.info(`Reading metadata from: ${metadataPath}`);
    
    let metadata;
    try {
      metadata = JSON.parse(metadataContent);
      logger.info(`Parsed metadata:`, metadata);
    } catch (error) {
      throw new Error(`Invalid metadata JSON: ${error.message}`);
    }
    
    const requiredFields = ['title', 'category', 'type', 'description'];
    const missingFields = requiredFields.filter(field => !metadata[field]);
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    const requiredFiles = ['video.mp4', 'thumbnail.jpg'];
    for (const file of requiredFiles) {
      const filePath = path.join(uploadDir, file);
      if (!files.includes(file)) {
        throw new Error(`Required file ${file} is missing`);
      }
      
      const stats = await fs.stat(filePath);
      logger.info(`File ${file} stats:`, stats);
      
      if (stats.size === 0) {
        throw new Error(`File ${file} is empty`);
      }
      
      if (file === 'video.mp4' && stats.size < 1024 * 1024) {
        throw new Error('Video file is too small, might be corrupted');
      }
    }

    logger.success(`Upload structure validation successful for: ${uploadDir}`);
    return metadata;
  } catch (error) {
    logger.error(`Upload structure validation failed for: ${uploadDir}`, error);
    throw new Error(`Validation error: ${error.message}`);
  }
}

// Convert video to HLS
async function convertToHLS(inputPath, outputFolder, movieId) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting HLS conversion for movie ID: ${movieId}`);
    const hlsPath = path.join(outputFolder, "master.m3u8");
    
    // Get video duration first
    exec(`ffprobe -v quiet -print_format json -show_format "${inputPath}"`, async (error, stdout) => {
      if (error) {
        logger.error(`FFprobe failed for movie ID: ${movieId}`, error);
        reject(error);
        return;
      }

      try {
        const metadata = JSON.parse(stdout);
        const duration = parseFloat(metadata.format.duration);
        logger.info(`Video duration: ${duration} seconds`);

        const ffmpegCmd = `
          ffmpeg -i "${inputPath}" \
          -progress pipe:1 \
          -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 2000k -bufsize 4000k -vf "scale=1280:720" -c:a aac -ar 48000 -b:a 128k \
          -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/720p_%03d.ts" -hls_playlist_type vod "${outputFolder}/720p.m3u8" \
          -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 1000k -bufsize 2000k -vf "scale=854:480" -c:a aac -ar 48000 -b:a 128k \
          -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/480p_%03d.ts" -hls_playlist_type vod "${outputFolder}/480p.m3u8" \
          -map 0:v -map 0:a? -c:v libx264 -crf 23 -maxrate 600k -bufsize 1200k -vf "scale=640:360" -c:a aac -ar 48000 -b:a 128k \
          -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/360p_%03d.ts" -hls_playlist_type vod "${outputFolder}/360p.m3u8"
        `;

        logger.info(`Executing FFmpeg command for ${movieId}`);
        const process = exec(ffmpegCmd);
        
        // Track progress
        process.stderr.on('data', async (data) => {
          const match = data.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
          if (match) {
            const [_, hours, minutes, seconds] = match;
            const time = (hours * 3600) + (minutes * 60) + parseFloat(seconds);
            const progress = Math.round((time / duration) * 100);
            
            await Movie.findByIdAndUpdate(movieId, {
              processingProgress: progress
            });
            
            if (progress % 10 === 0) {
              logger.info(`Conversion progress for movie ID ${movieId}: ${progress}%`);
            }
          }
        });

        process.on('exit', async (code) => {
          if (code === 0) {
            const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2128000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1128000,RESOLUTION=854x480
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=728000,RESOLUTION=640x360
360p.m3u8`;
            
            await fs.writeFile(hlsPath, masterContent);
            logger.success(`HLS conversion completed for movie ID: ${movieId}`);
            resolve(hlsPath);
          } else {
            logger.error(`FFmpeg process failed for movie ID: ${movieId}`, `Exit code: ${code}`);
            reject(new Error(`FFmpeg process exited with code ${code}`));
          }
        });

      } catch (error) {
        logger.error(`Error processing FFprobe output`, error);
        reject(error);
      }
    });
  });
}

// Process uploaded directory
async function processUploadedDirectory(dirPath) {
  const dirName = path.basename(dirPath);
  const processingPath = path.join(WATCH_DIRS.processing, dirName);
  let movieDoc;
  
  logger.info(`Starting processing for directory: ${dirName}`);
  
  try {
    // Move to processing directory
    await fs.rename(dirPath, processingPath);
    logger.info(`Moved to processing directory: ${processingPath}`);
    
    // Validate structure and get metadata
    const metadata = await validateUploadStructure(processingPath);
    
    // Create movie document
    movieDoc = new Movie({
      title: metadata.title,
      category: metadata.category,
      description: metadata.description,
      type: metadata.type,
      rentalPrice: metadata.rentalPrice,
      status: 'processing'
    });
    await movieDoc.save();
    logger.success(`Created movie document with ID: ${movieDoc._id}`);

    // Process video
    const videoPath = path.join(processingPath, 'video.mp4');
    const outputDir = path.join(WATCH_DIRS.completed, dirName, 'video');
    await fs.mkdir(outputDir, { recursive: true });

    // Convert to HLS
    await convertToHLS(videoPath, outputDir, movieDoc._id);

    // Update movie document with URLs
    const baseUrl = `https://theapix.in/uploads/completed/${dirName}`;
    await Movie.findByIdAndUpdate(movieDoc._id, {
      hlsUrl: `${baseUrl}/video/master.m3u8`,
      thumbnailUrl: `${baseUrl}/thumbnail.jpg`,
      trailerUrl: fsSync.existsSync(path.join(processingPath, 'trailer.mp4')) 
        ? `${baseUrl}/trailer.mp4` 
        : null,
      status: 'completed',
      processingProgress: 100
    });

    // Move processed files to completed directory
    await fs.rename(processingPath, path.join(WATCH_DIRS.completed, dirName));
    logger.success(`Processing completed for: ${dirName}`);
    
    return movieDoc._id;
  } catch (error) {
    logger.error(`Processing failed for ${dirName}`, error);
    
    // Move to failed directory
    try {
      if (fsSync.existsSync(processingPath)) {
        await fs.rename(processingPath, path.join(WATCH_DIRS.failed, dirName));
      } else if (fsSync.existsSync(dirPath)) {
        await fs.rename(dirPath, path.join(WATCH_DIRS.failed, dirName));
      }
    } catch (moveError) {
      logger.error(`Failed to move to failed directory: ${dirName}`, moveError);
    }
    
    // Update movie status if document was created
    if (movieDoc) {
      await Movie.findByIdAndUpdate(movieDoc._id, {
        status: 'failed',
        errorDetails: error.message
      });
    }
    
    throw error;
  }
}


// Add this new function before your watcher code
async function checkDirectoryDetails(dirPath) {
    try {
      logger.info(`Checking directory: ${dirPath}`);
      
      // Check if directory exists
      if (!fsSync.existsSync(dirPath)) {
        logger.error(`Directory does not exist: ${dirPath}`);
        return false;
      }
  
      // Check directory permissions
      try {
        fsSync.accessSync(dirPath, fsSync.constants.R_OK | fsSync.constants.W_OK);
        logger.info(`Directory permissions OK: ${dirPath}`);
      } catch (error) {
        logger.error(`Permission error on directory: ${dirPath}`, error);
        return false;
      }
  
      // List contents
      const contents = await fs.readdir(dirPath);
      logger.info(`Directory contents for ${dirPath}:`, contents);
  
      // Check required files
      const requiredFiles = ['metadata.json', 'video.mp4', 'thumbnail.jpg'];
      const missingFiles = requiredFiles.filter(file => !contents.includes(file));
      
      if (missingFiles.length > 0) {
        logger.error(`Missing required files in ${dirPath}:`, missingFiles);
        return false;
      }
  
      // Check metadata.json
      const metadataPath = path.join(dirPath, 'metadata.json');
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        logger.info(`Metadata content for ${dirPath}:`, metadata);
      } catch (error) {
        logger.error(`Error reading metadata.json in ${dirPath}:`, error);
        return false;
      }
  
      return true;
    } catch (error) {
      logger.error(`Error checking directory ${dirPath}:`, error);
      return false;
    }
  }
// Enhanced directory watcher with debug logging
// Replace your existing watcher code with this
const watcher = fsSync.watch(WATCH_DIRS.pending, { persistent: true });

logger.info(`Starting enhanced watcher for: ${WATCH_DIRS.pending}`);

// Check existing directories immediately
(async () => {
  const contents = await fs.readdir(WATCH_DIRS.pending);
  logger.info('Found existing directories:', contents);
  
  for (const dirName of contents) {
    const dirPath = path.join(WATCH_DIRS.pending, dirName);
    logger.info(`Checking existing directory: ${dirName}`);
    
    const isValid = await checkDirectoryDetails(dirPath);
    if (isValid) {
      logger.info(`Starting processing for existing directory: ${dirName}`);
      try {
        await processUploadedDirectory(dirPath);
      } catch (error) {
        logger.error(`Failed to process directory ${dirName}:`, error);
      }
    }
  }
})();

// Watch for new directories
watcher.on('rename', async (filename) => {
  const uploadPath = path.join(WATCH_DIRS.pending, filename);
  logger.info(`File event detected: ${filename}`);
  
  // Wait briefly for upload to complete
  setTimeout(async () => {
    if (fsSync.existsSync(uploadPath)) {
      const stats = await fs.stat(uploadPath);
      
      if (stats.isDirectory()) {
        logger.info(`New directory detected: ${filename}`);
        const isValid = await checkDirectoryDetails(uploadPath);
        
        if (isValid) {
          logger.info(`Starting processing for new directory: ${filename}`);
          try {
            await processUploadedDirectory(uploadPath);
          } catch (error) {
            logger.error(`Failed to process directory ${filename}:`, error);
          }
        }
      }
    }
  }, 5000);
});

watcher.on('error', (error) => {
  logger.error(`Watch error:`, error);
});

// Periodic check
setInterval(async () => {
  const contents = await fs.readdir(WATCH_DIRS.pending);
  if (contents.length > 0) {
    logger.info('Periodic check - pending directories:', contents);
    for (const dirName of contents) {
      const dirPath = path.join(WATCH_DIRS.pending, dirName);
      await checkDirectoryDetails(dirPath);
    }
  }
}, 30000);
// API Endpoints

// Get movie status
app.get("/movies/:id/status", async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) {
      logger.error(`Movie not found: ${req.params.id}`);
      return res.status(404).json({ error: "Movie not found" });
    }
    
    logger.info(`Status requested for movie: ${req.params.id}`, {
      status: movie.status,
      progress: movie.processingProgress
    });
    
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
  } catch (err) {
    logger.error(`Failed to fetch movie status: ${req.params.id}`, err);
    res.status(500).json({ error: "Failed to fetch movie status" });
  }
});

// Get all movies
app.get("/movies", async (req, res) => {
  try {
    const { category, type, limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit); // Ensure both are parsed as integers

    const query = {};
    if (category) query.category = category;
    if (type) query.type = type;

    const [movies, total] = await Promise.all([
      Movie.find(query)
        .sort({ uploadDate: -1 })
        .skip(skip)
        .limit(parseInt(limit)) // Ensure limit is parsed as an integer
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
app.get("/movies", async (req, res) => {
    try {
      const { category, type, limit = 20, page = 1 } = req.query;
      const skip = (page - 1) * limit;
  
      const query = {};
      if (category) query.category = category;
      if (type) query.type = type;
  
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
  

// Health check endpoint
app.get("/health", (req, res) => {
  const health = {
    uptime: process.uptime(),
    timestamp: Date.now(),
    mongoConnection: mongoose.connection.readyState === 1
  };
  
  // Check directory permissions
  Object.entries(WATCH_DIRS).forEach(([key, dir]) => {
    try {
      fsSync.accessSync(dir, fsSync.constants.R_OK | fsSync.constants.W_OK);
      health[`${key}DirAccess`] = true;
    } catch (error) {
      health[`${key}DirAccess`] = false;
    }
  });
  
  logger.info("Health check performed", health);
  res.json(health);
});

// Forgot password endpoint to send OTP
app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      logger.warn(`Password reset attempted for non-existent email: ${email}`);
      return res.status(404).json({ error: "User not found" });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    user.resetPasswordOtp = otp;
    user.resetPasswordExpires = Date.now() + 3600000; // OTP valid for 1 hour
    await user.save();

    // Send OTP email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Password Reset OTP',
      html: `
        <h2>Password Reset OTP</h2>
        <p>Your OTP for password reset is: <strong>${otp}</strong></p>
        <p>This OTP will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
      `
    };

    await transporter.sendMail(mailOptions);
    logger.success(`Password reset OTP sent to: ${email}`);
    res.json({ message: "Password reset OTP sent" });

  } catch (err) {
    logger.error("Failed to process forgot password request", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// OTP verification endpoint
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ 
      email,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      logger.warn(`Invalid or expired OTP verification attempt for email: ${email}`);
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Verify OTP
    if (user.resetPasswordOtp !== otp) {
      logger.warn(`Invalid OTP used for email: ${email}`);
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // OTP is valid, allow user to set a new password
    res.json({ message: "OTP verified successfully. You can now set a new password." });

  } catch (err) {
    logger.error("Failed to verify OTP", err);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// Reset password endpoint to update password
app.post("/reset-password", async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      logger.warn(`Password reset attempted for non-existent email: ${email}`);
      return res.status(404).json({ error: "User not found" });
    }

    // Update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.resetPasswordOtp = undefined; // Clear OTP
    user.resetPasswordExpires = undefined; // Clear expiration
    await user.save();

    logger.success(`Password reset successful for user: ${email}`);
    res.json({ message: "Password reset successful" });

  } catch (err) {
    logger.error("Failed to reset password", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Search Movies Endpoint
app.get("/movies/search", async (req, res) => {
  try {
    const { query } = req.query;
    const searchRegex = new RegExp(query, 'i'); // Case-insensitive search

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

// Start the server
app.listen(port, () => {
  logger.success(`Server running on http://localhost:${port}`);
  logger.info('Watch directories:', WATCH_DIRS);
});

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  watcher.close();
  mongoose.connection.close();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', reason);
});

