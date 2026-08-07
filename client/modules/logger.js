import { state } from './state.js';

const COLORS = {
  info: '#00f5a0',
  warn: '#ffeb3b',
  error: '#ff3a6e',
  time: '#6366f1'
};

function getTimestamp() {
  return new Date().toLocaleTimeString();
}

function pushLog(level, module, msg) {
  const logEntry = {
    timestamp: getTimestamp(),
    level,
    module,
    msg
  };
  state.logs.unshift(logEntry);
  if (state.logs.length > (state.MAX_LOGS || 100)) {
    state.logs.pop();
  }
}

export const Logger = {
  info: (module, msg) => {
    console.log(`%c[${getTimestamp()}] [${module}] ${msg}`, `color: ${COLORS.info}`);
    pushLog('info', module, msg);
  },
  warn: (module, msg) => {
    console.warn(`%c[${getTimestamp()}] [${module}] ${msg}`, `color: ${COLORS.warn}`);
    pushLog('warn', module, msg);
  },
  error: (module, msg, err) => {
    console.error(`%c[${getTimestamp()}] [${module}] ${msg}`, `color: ${COLORS.error}`, err || '');
    pushLog('error', module, msg + (err ? ` (${err.message})` : ''));
  },
  time: (module, label) => {
    console.time(`[${module}] ${label}`);
  },
  timeEnd: (module, label) => {
    console.timeEnd(`[${module}] ${label}`);
  }
};
