const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const OpenAIRequest = require('./OpenAIRequest');
const Logger = require('./Logger');
const RateLimiter = require('./RateLimiter');
const RequestValidator = require('./RequestValidator');
const Metrics = require('./Metrics');

let config = {};
let rateLimiter = null;
let metrics = null;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function parseEnvFile(filePath) {
  const envConfig = {};
  try {
    if (!fs.existsSync(filePath)) {
      return envConfig;
    }

    const envFile = fs.readFileSync(filePath, 'utf8');
    envFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) return;

      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }

      envConfig[key] = value;
    });

    return envConfig;
  } catch (error) {
    return envConfig;
  }
}

function loadConfig() {
  try {
    // Load .env first (lowest priority)
    const envPath = path.join(__dirname, '..', '.env');
    const envConfig = parseEnvFile(envPath);
    Object.assign(config, envConfig);

    if (Object.keys(envConfig).length > 0) {
      console.log('INFO: Loaded configuration from .env file');
    }

    // Load config.txt (overrides .env)
    const configPath = path.join(__dirname, 'config.txt');
    if (fs.existsSync(configPath)) {
      const configFile = fs.readFileSync(configPath, 'utf8');

      configFile.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim();
          const commentIndex = value.indexOf('#');
          config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
        }
      });
    }

    // Apply sensible defaults for missing values
    config.port = config.port || '42069';
    config.host = config.host || '0.0.0.0';
    config.log_level = config.log_level || 'INFO';
    config.log_format = config.log_format || 'text';
    config.max_body_bytes = config.max_body_bytes || '10485760';
    config.cors_origin = config.cors_origin || '*';
    config.rate_limit_enabled = config.rate_limit_enabled !== undefined ? config.rate_limit_enabled : 'true';
    config.rate_limit_max_requests = config.rate_limit_max_requests || '60';
    config.rate_limit_window_ms = config.rate_limit_window_ms || '60000';
    config.filter_sampling_params = config.filter_sampling_params || 'false';
    config.backend = (config.backend || 'openai').toLowerCase();
    config.auth_mode = (config.auth_mode || 'api_key').toLowerCase();
    config.openai_base_url = config.openai_base_url || 'https://api.openai.com/v1/chat/completions';

    Logger.init(config);

    // Validate configuration
    const validation = RequestValidator.validateConfig(config);
    if (validation.errors.length > 0) {
      validation.errors.forEach(err => Logger.error('Config error:', err));
      process.exit(1);
    }
    validation.warnings.forEach(warn => Logger.warn('Config warning:', warn));

    // Initialize rate limiter
    rateLimiter = new RateLimiter(config);

    // Initialize metrics
    metrics = new Metrics();

    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function getMaxBodyBytes() {
  const parsed = parseInt(config.max_body_bytes, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_MAX_BODY_BYTES;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let receivedBytes = 0;
    const maxBodyBytes = getMaxBodyBytes();
    let timeoutId = null;

    // Timeout for slow clients (30 seconds)
    timeoutId = setTimeout(() => {
      const error = new Error('Request body timeout');
      error.code = 'TIMEOUT';
      req.destroy();
      reject(error);
    }, 30000);

    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        clearTimeout(timeoutId);
        const error = new Error(`Payload too large (>${maxBodyBytes} bytes)`);
        error.code = 'PAYLOAD_TOO_LARGE';
        req.destroy();
        reject(error);
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      clearTimeout(timeoutId);
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        const parseError = new Error('Invalid JSON in request body');
        parseError.code = 'INVALID_JSON';
        reject(parseError);
      }
    });

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      Logger.error('Request body parse error:', err.message);
      const error = new Error('Failed to read request body');
      error.code = 'READ_ERROR';
      reject(error);
    });
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         '127.0.0.1';
}

async function handleRequest(req, res) {
  const startTime = Date.now();
  const clientIP = getClientIP(req);
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Generate request ID for correlation
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.requestId = requestId;

  Logger.info(`[${requestId}] ${req.method} ${pathname} from ${clientIP}`);

  // Record metrics on response finish
  const recordMetrics = () => {
    const duration = Date.now() - startTime;
    if (metrics) {
      metrics.recordRequest(pathname, res.statusCode, duration);
    }
  };
  res.on('finish', recordMetrics);
  res.on('close', recordMetrics);

  // Rate limiting check
  if (!rateLimiter.check(clientIP)) {
    Logger.warn(`[${requestId}] Rate limit exceeded for ${clientIP}`);
    if (metrics) {
      metrics.recordRateLimit();
    }
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retry_after: Math.ceil(parseInt(config.rate_limit_window_ms || 60000) / 1000)
    }));
    return;
  }

  const corsOrigin = config.cors_origin || '*';
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key');
  res.setHeader('X-Request-ID', requestId);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  req.setTimeout(120000, () => {
    Logger.warn('Request timed out');
    if (!res.headersSent) {
      res.writeHead(408, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Request timeout' }));
  });

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-code-proxy', backend: config.backend, timestamp: Date.now() }));
    return;
  }

  if (req.method === 'GET' && pathname === '/presets') {
    try {
      const presetsDir = path.join(__dirname, 'presets');
      const files = fs.readdirSync(presetsDir, { withFileTypes: true });
      const presets = files
        .filter(file => file.isFile() && file.name.endsWith('.json'))
        .map(file => path.basename(file.name, '.json'))
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ presets }));
    } catch (error) {
      Logger.error('Failed to list presets:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list presets' }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/metrics') {
    try {
      const acceptHeader = req.headers['accept'] || '';
      if (acceptHeader.includes('application/json')) {
        // Return JSON format
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics.toJSON(), null, 2));
      } else {
        // Return Prometheus text format (default)
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(metrics.toPrometheus());
      }
    } catch (error) {
      Logger.error('Failed to generate metrics:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate metrics' }));
    }
    return;
  }

  const isAnthropicPath = pathname === '/v1/messages' || /^\/v1\/\w+\/messages$/.test(pathname);
  const isOpenAIPath = pathname === '/v1/chat/completions' || /^\/v1\/\w+\/chat\/completions$/.test(pathname);

  if (req.method === 'POST' && (isAnthropicPath || isOpenAIPath)) {
    try {
      Logger.debug(`[${requestId}] Incoming request headers:`, JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug(`[${requestId}] Incoming request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));

      // Validate request body
      const requestBackend = isOpenAIPath ? 'openai' : (config.backend || 'anthropic');
      const validation = RequestValidator.validateRequest(body, requestBackend);
      if (!validation.valid) {
        Logger.warn(`[${requestId}] Request validation failed:`, validation.errors.join('; '));
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Invalid request',
            details: validation.errors
          }));
        }
        return;
      }

      let presetName = null;
      const parts = pathname.split('/');
      if (parts.length === 4 && parts[1] === 'v1' && parts[3] === 'messages') {
        presetName = RequestValidator.sanitizePresetName(parts[2]);
        if (presetName) {
          Logger.debug(`[${requestId}] Detected preset: ${presetName}`);
        }
      }
      if (parts.length === 5 && parts[1] === 'v1' && parts[3] === 'chat' && parts[4] === 'completions') {
        presetName = RequestValidator.sanitizePresetName(parts[2]);
        if (presetName) {
          Logger.debug(`[${requestId}] Detected preset: ${presetName}`);
        }
      }

      const requestHandler = requestBackend === 'openai'
        ? new OpenAIRequest(config, requestId, metrics, req)
        : new ClaudeRequest(req, requestId, metrics);

      await requestHandler.handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error(`[${requestId}] Request error:`, error.message);
      if (!res.headersSent) {
        if (error.code === 'INVALID_JSON') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        if (error.code === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        if (error.code === 'TIMEOUT') {
          res.writeHead(408, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      } else if (!res.destroyed) {
        res.end();
      }
    }
    return;
  }
  
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  loadConfig();

  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;
  const host = config.host || 'localhost';

  server.listen(port, host, () => {
    Logger.info('='.repeat(60));
    Logger.info('claude-code-proxy v1.2.0 - Production Ready');
    Logger.info(`Listening on ${host}:${port}`);
    Logger.info(`Health check: http://${host}:${port}/health`);
    Logger.info(`API endpoint: http://${host}:${port}/v1/messages`);
    Logger.info(`OpenAI endpoint: http://${host}:${port}/v1/chat/completions`);
    Logger.info(`Presets: http://${host}:${port}/presets`);
    Logger.info(`Metrics: http://${host}:${port}/metrics`);
    Logger.info(`Rate limiting: ${rateLimiter.enabled ? 'enabled' : 'disabled'}`);
    Logger.info(`Default backend: ${config.backend}`);
    Logger.info(`Log format: ${config.log_format || 'text'}`);
    Logger.info('='.repeat(60));
  });

  const gracefulShutdown = (signal) => {
    Logger.info(`${signal} received, shutting down gracefully...`);
    server.close((err) => {
      if (err) {
        Logger.error('Error during shutdown:', err.message);
        process.exit(1);
      }
      Logger.info('Server closed successfully');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      Logger.warn('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
