const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../config/logger');
const Movie = require('../models/Movie');

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

module.exports = {
  convertToHLS
}; 