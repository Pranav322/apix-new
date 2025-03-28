const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const logger = require('../config/logger');

// Define upload directories
const UPLOAD_DIR = '/home/theapix/public_html/uploads';
const WATCH_DIRS = {
  pending: path.join(UPLOAD_DIR, 'pending'),
  processing: path.join(UPLOAD_DIR, 'processing'),
  completed: path.join(UPLOAD_DIR, 'completed'),
  failed: path.join(UPLOAD_DIR, 'failed')
};

// Initialize directories
const initializeDirectories = () => {
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
};

async function copyRecursive(src, dest) {
  const stats = await fs.stat(src);
  
  if (stats.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      await copyRecursive(srcPath, destPath);
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

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

    // Different validation for shows and movies
    if (metadata.type === 'show') {
      if (!files.includes('thumbnail.jpg') && !files.includes('thumbnail.png')) {
        throw new Error('Either thumbnail.jpg or thumbnail.png is required for show');
      }
      // Show validation will be handled by validateShowStructure
    } else {
      // Movie validation
      const videoReq = 'video.mp4';
      const thumbnailReq = files.includes('thumbnail.jpg') ? 'thumbnail.jpg' : 
                           files.includes('thumbnail.png') ? 'thumbnail.png' : null;
      
      if (!thumbnailReq) {
        throw new Error('Either thumbnail.jpg or thumbnail.png is required');
      }
      
      const requiredFiles = [videoReq, thumbnailReq];
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
    }

    logger.success(`Upload structure validation successful for: ${uploadDir}`);
    return metadata;
  } catch (error) {
    logger.error(`Upload structure validation failed for: ${uploadDir}`, error);
    throw new Error(`Validation error: ${error.message}`);
  }
}

module.exports = {
  WATCH_DIRS,
  initializeDirectories,
  copyRecursive,
  validateUploadStructure
}; 
