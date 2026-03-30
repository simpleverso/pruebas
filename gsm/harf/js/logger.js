/**
 * Centralized Logger Module
 * Provides configurable log levels and formatted output to both DOM and console.
 */

export const LogLevel = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  SUCCESS: 4
});

const LEVEL_NAMES = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARNING]: 'WARNING',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.SUCCESS]: 'SUCCESS'
};

const LEVEL_CSS_CLASSES = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARNING]: 'warning',
  [LogLevel.ERROR]: 'error',
  [LogLevel.SUCCESS]: 'success'
};

const LEVEL_CONSOLE_METHODS = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARNING]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.SUCCESS]: 'log'
};

class Logger {
  constructor(minLevel = LogLevel.DEBUG) {
    this.minLevel = minLevel;
    this.history = [];
  }

  setLevel(level) {
    this.minLevel = level;
  }

  _formatTimestamp() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  }

  _log(level, module, message, data) {
    if (level < this.minLevel) return;

    const timestamp = this._formatTimestamp();
    const levelName = LEVEL_NAMES[level];
    const formatted = `[${timestamp}] [${levelName}] [${module}] ${message}`;

    this.history.push({ timestamp, level: levelName, module, message, data });

    // DOM output
    const logConsole = document.getElementById('logConsole');
    if (logConsole) {
      const entry = document.createElement('div');
      entry.className = `log-entry ${LEVEL_CSS_CLASSES[level]}`;
      entry.textContent = formatted;
      logConsole.appendChild(entry);
      logConsole.scrollTop = logConsole.scrollHeight;
    }

    // Console output
    const consoleMethod = LEVEL_CONSOLE_METHODS[level];
    if (data !== undefined) {
      console[consoleMethod](formatted, data);
    } else {
      console[consoleMethod](formatted);
    }
  }

  debug(module, message, data) {
    this._log(LogLevel.DEBUG, module, message, data);
  }

  info(module, message, data) {
    this._log(LogLevel.INFO, module, message, data);
  }

  warning(module, message, data) {
    this._log(LogLevel.WARNING, module, message, data);
  }

  error(module, message, data) {
    this._log(LogLevel.ERROR, module, message, data);
  }

  success(module, message, data) {
    this._log(LogLevel.SUCCESS, module, message, data);
  }

  downloadLogs() {
    const json = JSON.stringify(this.history, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hackrf-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

export default new Logger();
