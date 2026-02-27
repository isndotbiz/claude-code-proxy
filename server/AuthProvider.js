const https = require('https');
const Logger = require('./Logger');

class AuthProvider {
  constructor(config = {}, req = null, requestId = null) {
    this.config = config;
    this.req = req;
    this.requestId = requestId;
  }

  log(message) {
    return this.requestId ? `[${this.requestId}] ${message}` : message;
  }

  getMode() {
    return (this.config.auth_mode || 'api_key').toLowerCase();
  }

  getClientToken() {
    const tokenFromApiKey = this.req?.headers?.['x-api-key'];
    if (tokenFromApiKey && tokenFromApiKey.trim()) {
      return tokenFromApiKey.trim();
    }

    const auth = this.req?.headers?.authorization;
    if (auth && auth.trim()) {
      return auth.replace(/^Bearer\s+/i, '').trim();
    }

    return '';
  }

  async getOpenAIApiKey() {
    const mode = this.getMode();
    if (mode === 'token_broker') {
      return await this.getKeyFromBroker();
    }
    return this.getApiKeyDirect();
  }

  getApiKeyDirect() {
    const clientToken = this.getClientToken();
    if (clientToken) {
      return clientToken;
    }

    const configKey = this.config.openai_api_key;
    if (configKey && configKey.trim()) {
      return configKey.trim();
    }

    throw new Error('Missing OpenAI API key. Set openai_api_key in config/.env or send x-api-key/authorization header.');
  }

  async getKeyFromBroker() {
    const brokerUrl = this.config.token_broker_url;
    if (!brokerUrl) {
      throw new Error('auth_mode=token_broker requires token_broker_url');
    }

    const userToken = this.getClientToken();
    if (!userToken) {
      throw new Error('token_broker mode requires incoming x-api-key or Authorization bearer token');
    }

    const url = new URL(brokerUrl);
    const body = JSON.stringify({ audience: 'openai' });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${userToken}`,
      'User-Agent': 'claude-code-proxy-openai/1.0.0'
    };

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search || ''}`,
      method: 'POST',
      headers,
      timeout: 10000
    };

    Logger.debug(this.log(`Requesting token from broker ${url.hostname}`));

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode > 299) {
            reject(new Error(`Token broker request failed with status ${res.statusCode}`));
            return;
          }

          try {
            const parsed = JSON.parse(data || '{}');
            const apiKey = parsed.openai_api_key || parsed.api_key || parsed.token;
            if (!apiKey || typeof apiKey !== 'string') {
              reject(new Error('Token broker response missing openai_api_key/api_key/token'));
              return;
            }
            resolve(apiKey.trim());
          } catch (error) {
            reject(new Error('Token broker response was not valid JSON'));
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Token broker request timeout'));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = AuthProvider;
