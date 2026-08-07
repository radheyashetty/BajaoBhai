const { redis, isRedisReady } = require('./redisClient');

// Lazy Logger require to avoid circular dependency (Logger → nodeRegistry → Logger)
let _Logger;
function getLogger() {
  if (!_Logger) _Logger = require('./logger');
  return _Logger;
}

const NODE_ID = process.env.NODE_ID || `node-${process.pid}`;
const HEARTBEAT_TTL_SECONDS = 15;
const HEARTBEAT_INTERVAL_MS = 10 * 1000;

function nodeKey(nodeId = NODE_ID) {
  return `node:${nodeId}`;
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = String(nextCursor);
    if (Array.isArray(batch) && batch.length) {
      keys.push(...batch);
    }
  } while (cursor !== '0');
  return keys;
}

function snapshot() {
  return {
    nodeId: NODE_ID,
    pid: process.pid,
    port: Number(process.env.PORT) || 3002,
    startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

async function registerNode() {
  if (!isRedisReady()) return;
  try {
    await redis.setex(nodeKey(), HEARTBEAT_TTL_SECONDS, JSON.stringify(snapshot()));
  } catch (err) {
    getLogger().warn('nodeRegistry', `registerNode failed: ${err.message}`);
  }
}

async function deregisterNode() {
  if (!isRedisReady()) return;
  try {
    await redis.del(nodeKey());
  } catch (err) {
    getLogger().warn('nodeRegistry', `deregisterNode failed: ${err.message}`);
  }
}

async function getAliveNodes() {
  if (!isRedisReady()) return [];

  try {
    const keys = await scanKeys('node:*');
    if (!keys.length) return [];

    const raw = await redis.mget(...keys);
    return raw
      .filter(Boolean)
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  } catch (err) {
    getLogger().warn('nodeRegistry', `getAliveNodes failed: ${err.message}`);
    return [];
  }
}

function startNodeHeartbeat() {
  registerNode();
  const timer = setInterval(registerNode, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = {
  NODE_ID,
  registerNode,
  deregisterNode,
  getAliveNodes,
  startNodeHeartbeat,
};
