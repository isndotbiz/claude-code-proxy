// Simple Prometheus-compatible metrics collector
// No external dependencies - plain Node.js stdlib

class Metrics {
  constructor() {
    this.startTime = Date.now();
    this.requestCount = 0;
    this.requestsByStatus = {};
    this.requestsByEndpoint = {};
    this.errorCount = 0;
    this.rateLimitCount = 0;
    this.tokenRefreshCount = 0;
    this.requestDurations = [];
    this.maxDurations = 1000; // Keep last 1000 request durations
  }

  recordRequest(endpoint, statusCode, durationMs) {
    this.requestCount++;

    // Track by status code
    this.requestsByStatus[statusCode] = (this.requestsByStatus[statusCode] || 0) + 1;

    // Track by endpoint
    this.requestsByEndpoint[endpoint] = (this.requestsByEndpoint[endpoint] || 0) + 1;

    // Track errors (4xx and 5xx)
    if (statusCode >= 400) {
      this.errorCount++;
    }

    // Track request duration
    if (durationMs !== undefined && durationMs !== null) {
      this.requestDurations.push(durationMs);
      if (this.requestDurations.length > this.maxDurations) {
        this.requestDurations.shift();
      }
    }
  }

  recordRateLimit() {
    this.rateLimitCount++;
  }

  recordTokenRefresh() {
    this.tokenRefreshCount++;
  }

  calculatePercentile(arr, percentile) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  toPrometheus() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const lines = [];

    // Server uptime
    lines.push('# HELP claude_proxy_uptime_seconds Server uptime in seconds');
    lines.push('# TYPE claude_proxy_uptime_seconds counter');
    lines.push(`claude_proxy_uptime_seconds ${uptime}`);
    lines.push('');

    // Total requests
    lines.push('# HELP claude_proxy_requests_total Total number of HTTP requests');
    lines.push('# TYPE claude_proxy_requests_total counter');
    lines.push(`claude_proxy_requests_total ${this.requestCount}`);
    lines.push('');

    // Requests by status code
    lines.push('# HELP claude_proxy_requests_by_status_total Requests by HTTP status code');
    lines.push('# TYPE claude_proxy_requests_by_status_total counter');
    for (const [status, count] of Object.entries(this.requestsByStatus)) {
      lines.push(`claude_proxy_requests_by_status_total{status="${status}"} ${count}`);
    }
    lines.push('');

    // Requests by endpoint
    lines.push('# HELP claude_proxy_requests_by_endpoint_total Requests by endpoint path');
    lines.push('# TYPE claude_proxy_requests_by_endpoint_total counter');
    for (const [endpoint, count] of Object.entries(this.requestsByEndpoint)) {
      const sanitizedEndpoint = endpoint.replace(/"/g, '\\"');
      lines.push(`claude_proxy_requests_by_endpoint_total{endpoint="${sanitizedEndpoint}"} ${count}`);
    }
    lines.push('');

    // Error count
    lines.push('# HELP claude_proxy_errors_total Total number of error responses (4xx and 5xx)');
    lines.push('# TYPE claude_proxy_errors_total counter');
    lines.push(`claude_proxy_errors_total ${this.errorCount}`);
    lines.push('');

    // Rate limit hits
    lines.push('# HELP claude_proxy_rate_limit_hits_total Number of requests blocked by rate limiting');
    lines.push('# TYPE claude_proxy_rate_limit_hits_total counter');
    lines.push(`claude_proxy_rate_limit_hits_total ${this.rateLimitCount}`);
    lines.push('');

    // Token refreshes
    lines.push('# HELP claude_proxy_token_refreshes_total Number of OAuth token refreshes');
    lines.push('# TYPE claude_proxy_token_refreshes_total counter');
    lines.push(`claude_proxy_token_refreshes_total ${this.tokenRefreshCount}`);
    lines.push('');

    // Request duration percentiles
    if (this.requestDurations.length > 0) {
      const p50 = this.calculatePercentile(this.requestDurations, 50);
      const p90 = this.calculatePercentile(this.requestDurations, 90);
      const p95 = this.calculatePercentile(this.requestDurations, 95);
      const p99 = this.calculatePercentile(this.requestDurations, 99);

      lines.push('# HELP claude_proxy_request_duration_ms Request duration percentiles in milliseconds');
      lines.push('# TYPE claude_proxy_request_duration_ms gauge');
      lines.push(`claude_proxy_request_duration_ms{quantile="0.5"} ${p50.toFixed(2)}`);
      lines.push(`claude_proxy_request_duration_ms{quantile="0.9"} ${p90.toFixed(2)}`);
      lines.push(`claude_proxy_request_duration_ms{quantile="0.95"} ${p95.toFixed(2)}`);
      lines.push(`claude_proxy_request_duration_ms{quantile="0.99"} ${p99.toFixed(2)}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  toJSON() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    const percentiles = {};
    if (this.requestDurations.length > 0) {
      percentiles.p50 = this.calculatePercentile(this.requestDurations, 50);
      percentiles.p90 = this.calculatePercentile(this.requestDurations, 90);
      percentiles.p95 = this.calculatePercentile(this.requestDurations, 95);
      percentiles.p99 = this.calculatePercentile(this.requestDurations, 99);
    }

    return {
      uptime_seconds: uptime,
      requests: {
        total: this.requestCount,
        by_status: this.requestsByStatus,
        by_endpoint: this.requestsByEndpoint,
        errors: this.errorCount
      },
      rate_limiting: {
        hits: this.rateLimitCount
      },
      authentication: {
        token_refreshes: this.tokenRefreshCount
      },
      performance: {
        duration_ms: percentiles,
        samples: this.requestDurations.length
      }
    };
  }

  reset() {
    this.requestCount = 0;
    this.requestsByStatus = {};
    this.requestsByEndpoint = {};
    this.errorCount = 0;
    this.rateLimitCount = 0;
    this.requestDurations = [];
  }
}

module.exports = Metrics;
