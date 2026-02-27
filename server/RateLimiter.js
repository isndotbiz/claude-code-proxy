const Logger = require('./Logger');

class RateLimiter {
  constructor(config = {}) {
    this.enabled = config.rate_limit_enabled === 'true';
    this.maxRequests = parseInt(config.rate_limit_max_requests) || 60;
    this.windowMs = parseInt(config.rate_limit_window_ms) || 60000;
    this.clients = new Map();

    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);

    Logger.info(`RateLimiter initialized: ${this.enabled ? `enabled (${this.maxRequests} req/${this.windowMs}ms)` : 'disabled'}`);
  }

  check(clientIP) {
    if (!this.enabled) return true;

    const now = Date.now();
    const clientData = this.clients.get(clientIP) || { requests: [], blocked: false };

    // Remove requests outside the current window
    clientData.requests = clientData.requests.filter(timestamp => now - timestamp < this.windowMs);

    // Check if client is rate limited
    if (clientData.requests.length >= this.maxRequests) {
      clientData.blocked = true;
      this.clients.set(clientIP, clientData);
      Logger.warn(`Rate limit exceeded for ${clientIP}: ${clientData.requests.length} requests in ${this.windowMs}ms`);
      return false;
    }

    // Add this request
    clientData.requests.push(now);
    clientData.blocked = false;
    this.clients.set(clientIP, clientData);
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [clientIP, clientData] of this.clients.entries()) {
      // Remove clients with no recent requests
      clientData.requests = clientData.requests.filter(timestamp => now - timestamp < this.windowMs);
      if (clientData.requests.length === 0) {
        this.clients.delete(clientIP);
      }
    }
  }

  reset(clientIP) {
    this.clients.delete(clientIP);
  }
}

module.exports = RateLimiter;
