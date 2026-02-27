const Logger = require('./Logger');

class RequestValidator {
  static validateRequest(body, backend = 'anthropic') {
    if ((backend || '').toLowerCase() === 'openai') {
      return this.validateOpenAIRequest(body);
    }
    return this.validateClaudeRequest(body);
  }

  static validateClaudeRequest(body) {
    const errors = [];

    // Check required fields
    if (!body.model) {
      errors.push('Missing required field: model');
    } else if (typeof body.model !== 'string') {
      errors.push('Field "model" must be a string');
    } else {
      // Validate allowed models
      const allowedModels = [
        /^claude-sonnet-4-\d{8}$/,
        /^claude-3-7-sonnet-\d{8}$/,
        /^claude-3-6-sonnet-\d{8}$/,
        /^claude-3-5-haiku-\d{8}$/,
        /^claude-opus-4-\d{8}$/
      ];

      const isAllowed = allowedModels.some(pattern => pattern.test(body.model));
      if (!isAllowed) {
        errors.push(`Model "${body.model}" not allowed. Use exact dated versions: claude-sonnet-4-YYYYMMDD, claude-3-7-sonnet-YYYYMMDD, claude-3-6-sonnet-YYYYMMDD, claude-3-5-haiku-YYYYMMDD, or claude-opus-4-YYYYMMDD`);
      }
    }

    if (!body.messages) {
      errors.push('Missing required field: messages');
    } else if (!Array.isArray(body.messages)) {
      errors.push('Field "messages" must be an array');
    } else if (body.messages.length === 0) {
      errors.push('Field "messages" must not be empty');
    } else {
      // Validate message structure
      body.messages.forEach((msg, idx) => {
        if (!msg.role) {
          errors.push(`Message ${idx}: missing "role" field`);
        } else if (msg.role !== 'user' && msg.role !== 'assistant') {
          errors.push(`Message ${idx}: role must be "user" or "assistant", got "${msg.role}"`);
        }

        if (!msg.content) {
          errors.push(`Message ${idx}: missing "content" field`);
        }
      });
    }

    // Validate max_tokens if present
    if (body.max_tokens !== undefined) {
      if (typeof body.max_tokens !== 'number' || body.max_tokens < 1 || body.max_tokens > 200000) {
        errors.push('Field "max_tokens" must be a number between 1 and 200000');
      }
    }

    // Validate temperature if present
    if (body.temperature !== undefined) {
      if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1) {
        errors.push('Field "temperature" must be a number between 0 and 1');
      }
    }

    // Validate top_p if present
    if (body.top_p !== undefined) {
      if (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1) {
        errors.push('Field "top_p" must be a number between 0 and 1');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static validateOpenAIRequest(body) {
    const errors = [];

    if (!body || typeof body !== 'object') {
      errors.push('Request body must be a JSON object');
      return { valid: false, errors };
    }

    if (!body.model) {
      errors.push('Missing required field: model');
    } else if (typeof body.model !== 'string') {
      errors.push('Field "model" must be a string');
    }

    if (!Array.isArray(body.messages)) {
      errors.push('Field "messages" must be an array');
    } else if (body.messages.length === 0) {
      errors.push('Field "messages" must not be empty');
    } else {
      body.messages.forEach((msg, idx) => {
        if (!msg || typeof msg !== 'object') {
          errors.push(`Message ${idx}: must be an object`);
          return;
        }

        if (!msg.role) {
          errors.push(`Message ${idx}: missing "role" field`);
        } else if (!['system', 'user', 'assistant', 'tool', 'developer'].includes(msg.role)) {
          errors.push(`Message ${idx}: invalid role "${msg.role}"`);
        }

        if (msg.content === undefined || msg.content === null) {
          errors.push(`Message ${idx}: missing "content" field`);
        }
      });
    }

    if (body.temperature !== undefined) {
      if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) {
        errors.push('Field "temperature" must be a number between 0 and 2');
      }
    }

    if (body.top_p !== undefined) {
      if (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1) {
        errors.push('Field "top_p" must be a number between 0 and 1');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static sanitizePresetName(presetName) {
    if (!presetName || typeof presetName !== 'string') {
      return null;
    }

    // Remove path traversal attempts and special characters
    const sanitized = presetName.replace(/[^a-zA-Z0-9_-]/g, '');

    if (sanitized !== presetName) {
      Logger.warn(`Preset name sanitized: "${presetName}" -> "${sanitized}"`);
    }

    return sanitized || null;
  }

  static validateConfig(config) {
    const errors = [];
    const warnings = [];

    const backend = (config.backend || 'openai').toLowerCase();
    if (!['openai', 'anthropic'].includes(backend)) {
      errors.push(`Invalid backend: ${config.backend}. Valid options are "openai" or "anthropic".`);
    }

    if (backend === 'openai' && !config.openai_api_key) {
      warnings.push('backend=openai but openai_api_key is not set in config/.env. You must provide x-api-key or authorization header per request.');
    }

    const authMode = (config.auth_mode || 'api_key').toLowerCase();
    if (!['api_key', 'token_broker'].includes(authMode)) {
      errors.push(`Invalid auth_mode: ${config.auth_mode}. Valid options are "api_key" or "token_broker".`);
    }

    if (backend === 'openai' && authMode === 'token_broker' && !config.token_broker_url) {
      errors.push('auth_mode=token_broker requires token_broker_url in config/.env');
    }

    // Validate port
    const port = parseInt(config.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      errors.push(`Invalid port: ${config.port}. Must be between 1 and 65535.`);
    }

    // Validate host
    if (!config.host) {
      warnings.push('No host specified, using default "localhost"');
    }

    // Validate log level
    const validLogLevels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
    if (config.log_level && !validLogLevels.includes(config.log_level)) {
      warnings.push(`Invalid log_level: ${config.log_level}. Valid options: ${validLogLevels.join(', ')}. Using INFO.`);
    }

    // Validate rate limiting config
    if (config.rate_limit_enabled === 'true') {
      const maxReq = parseInt(config.rate_limit_max_requests);
      if (!Number.isFinite(maxReq) || maxReq < 1) {
        warnings.push(`Invalid rate_limit_max_requests: ${config.rate_limit_max_requests}. Using default 60.`);
      }

      const windowMs = parseInt(config.rate_limit_window_ms);
      if (!Number.isFinite(windowMs) || windowMs < 1000) {
        warnings.push(`Invalid rate_limit_window_ms: ${config.rate_limit_window_ms}. Using default 60000.`);
      }
    }

    return { errors, warnings };
  }
}

module.exports = RequestValidator;
