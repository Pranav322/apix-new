require("dotenv").config();
const express = require("express");
const multer = require("multer");
const SFTPClient = require("ssh2-sftp-client");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const stream = require('stream');

const app = express();
const port = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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
  status: { type: String, default: 'processing' }
});

const Movie = mongoose.model("Movie", movieSchema);

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
        -c:a aac -ar 48000 -b:a 128k \
        -map 0:v -map 0:a \
        -c:v libx264 -crf 23 -maxrate 2000k -bufsize 4000k -vf "scale=1280:720" \
        -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/720p_%03d.ts" \
        -hls_playlist_type vod "${outputFolder}/720p.m3u8" \
        -c:v libx264 -crf 23 -maxrate 1000k -bufsize 2000k -vf "scale=854:480" \
        -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/480p_%03d.ts" \
        -hls_playlist_type vod "${outputFolder}/480p.m3u8" \
        -c:v libx264 -crf 23 -maxrate 600k -bufsize 1200k -vf "scale=640:360" \
        -hls_time 6 -hls_list_size 0 -hls_segment_filename "${outputFolder}/360p_%03d.ts" \
        -hls_playlist_type vod "${outputFolder}/360p.m3u8"
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
  const { title, category, description } = req.body;
  
  if (!title || !category) {
    return res.status(400).json({ error: "Title and category are required" });
  }
  
  // Create movie document immediately with processing status
  const newMovie = new Movie({ 
    title, 
    category, 
    description, 
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

    await sftp.end();

    // Update movie document with final URLs
    await Movie.findByIdAndUpdate(movieId, {
      hlsUrl,
      trailerUrl,
      thumbnailUrl,
      status: 'completed'
    });
    
    console.log(`✅ Processing completed for movie: ${title}`);
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

app.get("/movies", async (req, res) => {
  try {
    const { category, limit = 20, page = 1 } = req.query;
    const skip = (page - 1) * limit;
    
    const query = category ? { category } : {};
    
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

// Start the server
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));