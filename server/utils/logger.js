const { NODE_ID } = require('./nodeRegistry');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../../server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function getTimestamp() {
  return new Date().toISOString();
}

function formatMsg(module, msg) {
  return `[${getTimestamp()}] [${NODE_ID || 'node'}] [${module}] ${msg}`;
}

const Logger = {
  info: (module, msg) => {
    const formatted = formatMsg(module, msg);
    console.log(formatted);
    logStream.write(formatted + '\n');
  },
  warn: (module, msg) => {
    const formatted = formatMsg(module, msg);
    console.warn(formatted);
    logStream.write(formatted + '\n');
  },
  error: (module, msg, err) => {
    const trace = err ? `\nStack: ${err.stack || err.message}` : '';
    const formatted = formatMsg(module, msg) + trace;
    console.error(formatted);
    logStream.write(formatted + '\n');
  },
  time: (module, label) => {
    console.time(`[${NODE_ID || 'node'}] [${module}] ${label}`);
  },
  timeEnd: (module, label) => {
    console.timeEnd(`[${NODE_ID || 'node'}] [${module}] ${label}`);
  },
};

module.exports = Logger;
