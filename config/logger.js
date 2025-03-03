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

module.exports = logger; 