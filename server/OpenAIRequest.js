const https = require('https');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');
const AuthProvider = require('./AuthProvider');

class OpenAIRequest {
  static presetCache = new Map();

  constructor(config = {}, requestId = null, metrics = null, req = null) {
    this.config = config;
    this.requestId = requestId;
    this.metrics = metrics;
    this.req = req;
    this.authProvider = new AuthProvider(config, req, requestId);
    this.API_URL = config.openai_base_url || 'https://api.openai.com/v1/chat/completions';
  }

  log(message) {
    return this.requestId ? `[${this.requestId}] ${message}` : message;
  }

  getHeaders(apiKey) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'claude-code-proxy-openai/1.0.0'
    };
  }

  normalizeMessageContent(content) {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .map(part => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
            return part.text;
          }
          return '';
        })
        .filter(Boolean);
      return textParts.join('\n');
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
      return content.text;
    }

    return String(content ?? '');
  }

  normalizeOpenAIBody(body) {
    const normalized = JSON.parse(JSON.stringify(body || {}));

    if (Array.isArray(normalized.messages)) {
      normalized.messages = normalized.messages.map(msg => {
        if (!msg || typeof msg !== 'object') {
          return msg;
        }
        return {
          ...msg,
          content: this.normalizeMessageContent(msg.content)
        };
      });
    }

    if (Array.isArray(normalized.system) && normalized.system.length > 0) {
      const systemText = normalized.system
        .map(item => this.normalizeMessageContent(item))
        .filter(Boolean)
        .join('\n');

      if (systemText) {
        normalized.messages = normalized.messages || [];
        normalized.messages.unshift({ role: 'system', content: systemText });
      }

      delete normalized.system;
    }

    delete normalized.thinking;

    if (normalized.max_completion_tokens !== undefined && normalized.max_tokens === undefined) {
      normalized.max_tokens = normalized.max_completion_tokens;
      delete normalized.max_completion_tokens;
    }

    return normalized;
  }

  loadPreset(presetName) {
    if (OpenAIRequest.presetCache.has(presetName)) {
      return OpenAIRequest.presetCache.get(presetName);
    }

    try {
      const presetPath = path.join(__dirname, 'presets', `${presetName}.json`);
      const presetData = fs.readFileSync(presetPath, 'utf8');
      const preset = JSON.parse(presetData);
      OpenAIRequest.presetCache.set(presetName, preset);
      return preset;
    } catch (error) {
      Logger.info(`Failed to load preset ${presetName}: ${error.message}`);
      OpenAIRequest.presetCache.set(presetName, null);
      return null;
    }
  }

  applyPreset(body, presetName) {
    if (!presetName) {
      return body;
    }

    const preset = this.loadPreset(presetName);
    if (!preset) {
      Logger.warn(`Unknown preset: ${presetName}`);
      return body;
    }

    body.messages = Array.isArray(body.messages) ? body.messages : [];

    if (preset.system) {
      body.messages.unshift({ role: 'system', content: preset.system });
    }

    const suffix = preset.suffixEt || preset.suffix;
    if (suffix) {
      const lastUserIdx = body.messages.map(m => m?.role).lastIndexOf('user');
      if (lastUserIdx !== -1) {
        const message = body.messages[lastUserIdx];
        const existingContent = this.normalizeMessageContent(message.content);
        body.messages[lastUserIdx] = {
          ...message,
          content: existingContent ? `${existingContent}\n\n${suffix}` : suffix
        };
      }
    }

    return body;
  }

  processRequestBody(body, presetName = null) {
    let processed = this.normalizeOpenAIBody(body);
    processed = this.applyPreset(processed, presetName);
    return processed;
  }

  async makeRequest(body, presetName = null) {
    const apiKey = await this.authProvider.getOpenAIApiKey();
    const headers = this.getHeaders(apiKey);
    const processedBody = this.processRequestBody(body, presetName);

    Logger.debug(this.log('Outgoing headers to OpenAI:'), JSON.stringify(headers, null, 2));
    Logger.debug(this.log(`Final request to OpenAI (${JSON.stringify(processedBody).length} bytes):`), JSON.stringify(processedBody, null, 2));

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: `${urlParts.pathname}${urlParts.search || ''}`,
      method: 'POST',
      headers,
      timeout: 120000
    };

    return new Promise((resolve, reject) => {
      const upstreamReq = https.request(options, (upstreamRes) => {
        resolve(upstreamRes);
      });

      upstreamReq.setTimeout(120000, () => {
        upstreamReq.destroy();
        reject(new Error('OpenAI API request timeout'));
      });

      upstreamReq.on('error', reject);
      upstreamReq.write(JSON.stringify(processedBody));
      upstreamReq.end();
    });
  }

  async handleResponse(res, body, presetName = null) {
    try {
      const upstreamResponse = await this.makeRequest(body, presetName);
      res.statusCode = upstreamResponse.statusCode;

      Object.keys(upstreamResponse.headers).forEach(key => {
        if (key.toLowerCase() === 'content-encoding') {
          return;
        }
        res.setHeader(key, upstreamResponse.headers[key]);
      });

      this.streamResponse(res, upstreamResponse);
    } catch (error) {
      Logger.error(this.log('OpenAI request error:'), error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      } else if (!res.destroyed) {
        res.end();
      }
    }
  }

  streamResponse(res, upstreamResponse) {
    const extractOpenAIText = (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.substring(6).trim();
            if (payload === '[DONE]') {
              return null;
            }
            const data = JSON.parse(payload);
            const delta = data?.choices?.[0]?.delta?.content;
            if (delta) {
              return { text: delta };
            }
          }
        }
      } catch (error) {
      }
      return null;
    };

    const contentType = upstreamResponse.headers['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      upstreamResponse.on('error', (error) => {
        Logger.debug('OpenAI response stream error:', error.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Upstream response error' }));
        }
      });

      res.on('close', () => {
        if (!upstreamResponse.destroyed) {
          upstreamResponse.destroy();
        }
      });

      if (Logger.getLogLevel() >= 3) {
        const debugStream = Logger.createDebugStream('OpenAI SSE', extractOpenAIText);
        upstreamResponse.pipe(debugStream).pipe(res);
      } else {
        upstreamResponse.pipe(res);
      }
      return;
    }

    let responseData = '';
    upstreamResponse.on('data', chunk => {
      responseData += chunk;
    });
    upstreamResponse.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(responseData);
    });
  }
}

module.exports = OpenAIRequest;
