const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Movie = require('../models/Movie');
const logger = require('../config/logger');
const { WATCH_DIRS, validateUploadStructure, copyRecursive } = require('./fileManagement');
const { convertToHLS } = require('./videoProcessing');

async function processShowDirectory(dirPath, metadata) {
  const showDoc = new Movie({
    title: metadata.title,
    category: metadata.category,
    description: metadata.description,
    type: 'show',
    rentalPrice: metadata.rentalPrice,
    status: 'processing',
    seasons: []
  });
  await showDoc.save();
  logger.success(`Created show document with ID: ${showDoc._id}`);

  // Process each season
  for (const season of metadata.seasons) {
    const seasonObj = {
      seasonNumber: season.seasonNumber,
      title: season.title,
      description: season.description,
      episodes: []
    };

    // Process each episode in the season
    for (const episode of season.episodes) {
      const episodePath = path.join(dirPath, `s${season.seasonNumber}e${episode.episodeNumber}`);
      const outputDir = path.join(episodePath, 'video');
      await fs.mkdir(outputDir, { recursive: true });

      const videoPath = path.join(episodePath, 'video.mp4');
      if (!fsSync.existsSync(videoPath)) {
        throw new Error(`Video file not found for episode ${episode.episodeNumber} of season ${season.seasonNumber}`);
      }

      await convertToHLS(videoPath, outputDir, showDoc._id);

      const baseUrl = `https://theapix.in/uploads/completed/${path.basename(dirPath)}/s${season.seasonNumber}e${episode.episodeNumber}`;
      
      const episodeObj = {
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        description: episode.description,
        duration: episode.duration,
        hlsUrl: `${baseUrl}/video/master.m3u8`,
        thumbnailUrl: `${baseUrl}/thumbnail.jpg`,
        status: 'completed',
        processingProgress: 100
      };

      seasonObj.episodes.push(episodeObj);
    }

    showDoc.seasons.push(seasonObj);
  }

  await showDoc.save();
  logger.success(`Show processing completed: ${showDoc.title}`);
  return showDoc._id;
}

async function validateShowStructure(dirPath, metadata) {
  if (!metadata.seasons || !Array.isArray(metadata.seasons)) {
    throw new Error('Show metadata must include seasons array');
  }

  for (const season of metadata.seasons) {
    if (!season.seasonNumber || !season.title || !season.episodes) {
      throw new Error(`Invalid season structure in metadata`);
    }

    for (const episode of season.episodes) {
      if (!episode.episodeNumber || !episode.title) {
        throw new Error(`Invalid episode structure in season ${season.seasonNumber}`);
      }

      const episodePath = path.join(dirPath, `s${season.seasonNumber}e${episode.episodeNumber}`);
      if (!fsSync.existsSync(episodePath)) {
        throw new Error(`Missing directory for episode ${episode.episodeNumber} of season ${season.seasonNumber}`);
      }

      const requiredFiles = ['video.mp4', 'thumbnail.jpg'];
      for (const file of requiredFiles) {
        if (!fsSync.existsSync(path.join(episodePath, file))) {
          throw new Error(`Missing ${file} for episode ${episode.episodeNumber} of season ${season.seasonNumber}`);
        }
      }
    }
  }
}

async function processUploadedDirectory(dirPath) {
  const dirName = path.basename(dirPath);
  const processingPath = path.join(WATCH_DIRS.processing, dirName);
  const completedPath = path.join(WATCH_DIRS.completed, dirName);
  const failedPath = path.join(WATCH_DIRS.failed, dirName);
  let contentDoc;
  
  logger.info(`Starting processing for directory: ${dirName}`);
  
  try {
    if (fsSync.existsSync(processingPath)) {
      await fs.rm(processingPath, { recursive: true, force: true });
      logger.info(`Cleaned existing processing directory: ${processingPath}`);
    }
    await fs.mkdir(processingPath, { recursive: true });

    logger.info(`Copying files from ${dirPath} to ${processingPath}`);
    await copyRecursive(dirPath, processingPath);
    logger.info(`Copied all files from pending to processing`);

    await fs.rm(dirPath, { recursive: true, force: true });
    logger.info(`Removed source directory: ${dirPath}`);
    
    const metadata = await validateUploadStructure(processingPath);
    
    if (metadata.type === 'show') {
      await validateShowStructure(processingPath, metadata);
      contentDoc = await processShowDirectory(processingPath, metadata);
    } else {
      // Existing movie processing logic
      contentDoc = new Movie({
        title: metadata.title,
        category: metadata.category,
        description: metadata.description,
        type: metadata.type,
        rentalPrice: metadata.rentalPrice,
        status: 'processing'
      });
      await contentDoc.save();
      logger.success(`Created movie document with ID: ${contentDoc._id}`);

      const videoPath = path.join(processingPath, 'video.mp4');
      const outputDir = path.join(processingPath, 'video');
      await fs.mkdir(outputDir, { recursive: true });

      await convertToHLS(videoPath, outputDir, contentDoc._id);

      const baseUrl = `https://theapix.in/uploads/completed/${dirName}`;
      await Movie.findByIdAndUpdate(contentDoc._id, {
        hlsUrl: `${baseUrl}/video/master.m3u8`,
        thumbnailUrl: `${baseUrl}/thumbnail.jpg`,
        trailerUrl: fsSync.existsSync(path.join(processingPath, 'trailer.mp4')) 
          ? `${baseUrl}/trailer.mp4` 
          : null,
        status: 'completed',
        processingProgress: 100
      });
    }

    // Move to completed directory
    if (fsSync.existsSync(completedPath)) {
      await fs.rm(completedPath, { recursive: true, force: true });
    }
    await fs.mkdir(completedPath, { recursive: true });
    await copyRecursive(processingPath, completedPath);
    await fs.rm(processingPath, { recursive: true, force: true });
    
    logger.success(`Processing completed for: ${dirName}`);
    return contentDoc._id;
  } catch (error) {
    logger.error(`Processing failed for ${dirName}`, error);
    
    try {
      if (fsSync.existsSync(failedPath)) {
        await fs.rm(failedPath, { recursive: true, force: true });
        logger.info(`Cleaned existing failed directory for this movie: ${failedPath}`);
      }
      await fs.mkdir(failedPath, { recursive: true });

      const sourceDir = fsSync.existsSync(processingPath) ? processingPath : dirPath;
      if (fsSync.existsSync(sourceDir)) {
        logger.info(`Copying failed files from ${sourceDir} to ${failedPath}`);
        await copyRecursive(sourceDir, failedPath);
        logger.info(`Copied all failed files`);

        await fs.rm(sourceDir, { recursive: true, force: true });
        logger.info(`Removed source directory after failure: ${sourceDir}`);
      }
    } catch (moveError) {
      logger.error(`Failed to move to failed directory: ${dirName}`, moveError);
    }
    
    if (contentDoc) {
      await Movie.findByIdAndUpdate(contentDoc._id, {
        status: 'failed',
        errorDetails: error.message
      });
    }
    
    throw error;
  }
}

async function checkDirectoryDetails(dirPath) {
  try {
    logger.info(`Checking directory: ${dirPath}`);
    
    if (!fsSync.existsSync(dirPath)) {
      logger.error(`Directory does not exist: ${dirPath}`);
      return false;
    }

    try {
      fsSync.accessSync(dirPath, fsSync.constants.R_OK | fsSync.constants.W_OK);
      logger.info(`Directory permissions OK: ${dirPath}`);
    } catch (error) {
      logger.error(`Permission error on directory: ${dirPath}`, error);
      return false;
    }

    const contents = await fs.readdir(dirPath);
    logger.info(`Directory contents for ${dirPath}:`, contents);

    // Check metadata.json first
    if (!contents.includes('metadata.json')) {
      logger.error(`Missing metadata.json in ${dirPath}`);
      return false;
    }

    // Read and parse metadata.json
    const metadataPath = path.join(dirPath, 'metadata.json');
    let metadata;
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      logger.info(`Metadata content for ${dirPath}:`, metadata);
    } catch (error) {
      logger.error(`Error reading metadata.json in ${dirPath}:`, error);
      return false;
    }

    // Different validation for shows and movies
    if (metadata.type === 'show') {
      // For shows, we need thumbnail.jpg and metadata.json in main directory
      if (!contents.includes('thumbnail.jpg')) {
        logger.error(`Missing thumbnail.jpg for show in ${dirPath}`);
        return false;
      }

      // Validate show structure
      if (!metadata.seasons || !Array.isArray(metadata.seasons)) {
        logger.error(`Invalid show metadata: missing seasons array`);
        return false;
      }

      // Check each season and episode directory
      for (const season of metadata.seasons) {
        for (const episode of season.episodes) {
          const episodeDirName = `s${season.seasonNumber}e${episode.episodeNumber}`;
          if (!contents.includes(episodeDirName)) {
            logger.error(`Missing episode directory: ${episodeDirName}`);
            return false;
          }

          // Check episode directory contents
          const episodePath = path.join(dirPath, episodeDirName);
          const episodeContents = await fs.readdir(episodePath);
          const requiredEpisodeFiles = ['video.mp4', 'thumbnail.jpg'];
          
          for (const file of requiredEpisodeFiles) {
            if (!episodeContents.includes(file)) {
              logger.error(`Missing ${file} in episode directory: ${episodeDirName}`);
              return false;
            }
          }
        }
      }
    } else {
      // For movies, check for video.mp4 and thumbnail.jpg
      const requiredFiles = ['video.mp4', 'thumbnail.jpg'];
      const missingFiles = requiredFiles.filter(file => !contents.includes(file));
      
      if (missingFiles.length > 0) {
        logger.error(`Missing required files in ${dirPath}:`, missingFiles);
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.error(`Error checking directory ${dirPath}:`, error);
    return false;
  }
}

async function processAllPendingDirectories() {
  try {
    const contents = await fs.readdir(WATCH_DIRS.pending);
    logger.info('Checking pending directories:', contents);
    
    for (const dirName of contents) {
      const dirPath = path.join(WATCH_DIRS.pending, dirName);
      const stats = await fs.stat(dirPath);
      
      if (stats.isDirectory()) {
        logger.info(`Found directory: ${dirName}`);
        const isValid = await checkDirectoryDetails(dirPath);
        
        if (isValid) {
          logger.info(`Starting processing for directory: ${dirName}`);
          try {
            await processUploadedDirectory(dirPath);
          } catch (error) {
            logger.error(`Failed to process directory ${dirName}:`, error);
          }
        } else {
          logger.warn(`Invalid directory structure: ${dirName}`);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing pending directories:', error);
  }
}

function setupDirectoryWatcher() {
  const watcher = fsSync.watch(WATCH_DIRS.pending, { persistent: true });

  logger.info(`Starting enhanced watcher for: ${WATCH_DIRS.pending}`);

  // Process existing directories on startup
  processAllPendingDirectories();

  // Set up periodic check for new directories
  const checkInterval = 30000; // 30 seconds
  setInterval(processAllPendingDirectories, checkInterval);

  // Watch for new directories
  watcher.on('rename', async (filename) => {
    const uploadPath = path.join(WATCH_DIRS.pending, filename);
    logger.info(`File event detected: ${filename}`);
    
    // Wait briefly for upload to complete
    setTimeout(async () => {
      try {
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
            } else {
              logger.warn(`Invalid directory structure: ${filename}`);
            }
          }
        }
      } catch (error) {
        logger.error(`Error handling new directory ${filename}:`, error);
      }
    }, 5000); // 5 second delay to ensure upload is complete
  });

  watcher.on('error', (error) => {
    logger.error(`Watch error:`, error);
    // Attempt to restart watcher on error
    try {
      watcher.close();
      const newWatcher = fsSync.watch(WATCH_DIRS.pending, { persistent: true });
      Object.assign(watcher, newWatcher);
      logger.info('Watcher restarted successfully');
    } catch (restartError) {
      logger.error('Failed to restart watcher:', restartError);
    }
  });

  return watcher;
}

module.exports = {
  setupDirectoryWatcher
}; 