const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

const authenticateJWT = (req, res, next) => {
  const authHeader = req.header("Authorization");
  logger.info(`Auth header received: ${authHeader}`);
  
  const token = authHeader?.split(" ")[1];
  if (!token) {
    logger.error('No token provided');
    return res.status(403).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      logger.error(`Token verification failed: ${err.message}`);
      return res.status(403).json({ error: "Token verification failed", details: err.message });
    }
    
    logger.info(`Token verified for user: ${user.id}`);
    req.user = user;
    next();
  });
};

module.exports = authenticateJWT; 