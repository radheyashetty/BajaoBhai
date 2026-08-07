const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
});
// NOTE: Logger cannot be used at module init time due to circular dependency
// (redisClient → Logger → nodeRegistry → redisClient). Use lazy require below.
let _Logger;
function getLogger() {
  if (!_Logger) _Logger = require('./logger');
  return _Logger;
}

redis.on('connect', () => console.log(`[redis] Redis connected`));
redis.on('error', (err) => console.error(`[redis] Redis error: ${err.message}`));

const QUEUE_TTL = 600;
const NOW_PLAYING_TTL = 6 * 60 * 60;

// In-memory fallback for important state when Redis is unavailable
const fallbackNowPlaying = new Map();
let fallbackPlaybackMode = 'api';

async function getGlobalPlaybackMode() {
  if (!isRedisReady()) return fallbackPlaybackMode;
  try {
    const mode = await redis.get('global:playbackMode');
    return mode || fallbackPlaybackMode;
  } catch (err) {
    return fallbackPlaybackMode;
  }
}

async function setGlobalPlaybackMode(mode) {
  fallbackPlaybackMode = mode;
  if (!isRedisReady()) return;
  try {
    await redis.set('global:playbackMode', mode);
  } catch (err) {
    getLogger().warn('redis', `setGlobalPlaybackMode failed: ${err.message}`);
  }
}

function queueKey(partyCode) {
  return `queue:${partyCode}`;
}

function nowPlayingKey(partyCode) {
  return `nowPlaying:${partyCode}`;
}

function isRedisReady() {
  return redis.status === 'ready';
}

async function getCachedQueue(partyCode) {
  if (!isRedisReady()) return null;
  try {
    const maybe = await redis.get(queueKey(partyCode));
    if (!maybe) return null;
    return JSON.parse(maybe);
  } catch (err) {
    getLogger().warn('redis', `getCachedQueue failed: ${err.message}`);
    return null;
  }
}

async function setCachedQueue(partyCode, queue) {
  if (!isRedisReady()) return;
  try {
    await redis.setex(queueKey(partyCode), QUEUE_TTL, JSON.stringify(queue));
  } catch (err) {
    getLogger().warn('redis', `setCachedQueue failed: ${err.message}`);
  }
}

async function invalidateQueue(partyCode) {
  if (!isRedisReady()) return;
  try {
    await redis.del(queueKey(partyCode));
  } catch (err) {
    getLogger().warn('redis', `invalidateQueue failed: ${err.message}`);
  }
}

async function getNowPlayingState(partyCode) {
  if (!isRedisReady()) return fallbackNowPlaying.get(partyCode) || null;
  try {
    const maybe = await redis.get(nowPlayingKey(partyCode));
    if (!maybe) return fallbackNowPlaying.get(partyCode) || null;
    return JSON.parse(maybe);
  } catch (err) {
    getLogger().warn('redis', `getNowPlayingState failed: ${err.message}`);
    return fallbackNowPlaying.get(partyCode) || null;
  }
}

async function setNowPlayingState(partyCode, state) {
  fallbackNowPlaying.set(partyCode, state);
  if (!isRedisReady()) return;
  try {
    await redis.setex(nowPlayingKey(partyCode), NOW_PLAYING_TTL, JSON.stringify(state));
  } catch (err) {
    getLogger().warn('redis', `setNowPlayingState failed: ${err.message}`);
  }
}

async function clearNowPlayingState(partyCode) {
  fallbackNowPlaying.delete(partyCode);
  if (!isRedisReady()) return;
  try {
    await redis.del(nowPlayingKey(partyCode));
  } catch (err) {
    getLogger().warn('redis', `clearNowPlayingState failed: ${err.message}`);
  }
}

async function connectRedis() {
  if (redis.status === 'ready') {
    return redis;
  }
  if (redis.status === 'connecting') {
    return new Promise((resolve, reject) => {
      redis.once('ready', () => resolve(redis));
      redis.once('error', reject);
    });
  }

  try {
    await redis.connect();
    return redis;
  } catch (err) {
    // Redis is optional for local/dev usage; fall back gracefully.
    getLogger().warn('redis', `Redis connection failed, continuing without cache: ${err.message}`);
    return null;
  }
}

module.exports = {
  redis,
  isRedisReady,
  connectRedis,
  getCachedQueue,
  setCachedQueue,
  invalidateQueue,
  getNowPlayingState,
  setNowPlayingState,
  clearNowPlayingState,
  getGlobalPlaybackMode,
  setGlobalPlaybackMode,
};
