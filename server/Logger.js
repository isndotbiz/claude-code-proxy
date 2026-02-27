const { Transform } = require('stream');

class Logger {
  static init(config) {
    this.config = config;
  }

  static getLogLevel() {
    const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
    return levels[this.config?.log_level] || 2;
  }

  static getLogFormat() {
    return this.config?.log_format || 'text';
  }

  static formatLog(level, ...args) {
    if (this.getLogFormat() === 'json') {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');

      const logEntry = {
        timestamp: new Date().toISOString(),
        level: level,
        message: message
      };

      return JSON.stringify(logEntry);
    } else {
      return `${level}: ${args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ')}`;
    }
  }

  static debug(...args) {
    if (this.getLogLevel() >= 3) {
      console.log(this.formatLog('DEBUG', ...args));
    }
  }

  static trace(...args) {
    if (this.getLogLevel() >= 4) {
      console.log(this.formatLog('TRACE', ...args));
    }
  }

  static info(...args) {
    console.log(this.formatLog('INFO', ...args));
  }

  static warn(...args) {
    console.warn(this.formatLog('WARN', ...args));
  }

  static error(...args) {
    console.error(this.formatLog('ERROR', ...args));
  }

  static createDebugStream(label = 'Stream chunk', textExtractor = null) {
    if (this.getLogLevel() < 3) {
      return new Transform({
        transform(chunk, encoding, callback) {
          callback(null, chunk);
        }
      });
    }

    let streamingText = '';
    let thinkingText = '';
    let hasStartedStreaming = false;
    let hasStartedResponse = false;
    const logLevel = this.getLogLevel();
    
    return new Transform({
      transform(chunk, encoding, callback) {
        try {
          const chunkStr = chunk.toString();
          
          if (logLevel >= 4) {
            Logger.trace(`${label} (${chunkStr.length} bytes): ${chunkStr}`);
          } else if (logLevel >= 3) {
            if (textExtractor) {
              const result = textExtractor(chunk);
              if (result?.text) {
                if (!hasStartedStreaming) {
                  Logger.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                if (thinkingText && !hasStartedResponse) {
                  process.stdout.write('\n');
                  Logger.debug(`${label} switching from thinking to response`);
                  hasStartedResponse = true;
                }
                streamingText += result.text;
                process.stdout.write(result.text);
              }
              if (result?.thinking) {
                if (!hasStartedStreaming) {
                  Logger.debug(`${label} streaming started`);
                  hasStartedStreaming = true;
                }
                thinkingText += result.thinking;
                process.stdout.write(`\x1b[90m${result.thinking}\x1b[0m`);
              }
            } else {
              Logger.debug(`${label} (${chunkStr.length} bytes): ${chunkStr}`);
            }
          }
        } catch (error) {
          Logger.debug(`${label} (failed to decode):`, chunk);
        }
        callback(null, chunk);
      }
    });
  }

}

module.exports = Logger;