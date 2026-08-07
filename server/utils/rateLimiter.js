const { redis, isRedisReady } = require('./redisClient');
const Logger = require('./logger');

const localRateWindow = new Map();

// Periodically sweep expired entries to prevent memory leaks from inactive sessions
setInterval(
  () => {
    const now = Date.now();
    for (const [key, val] of localRateWindow.entries()) {
      if (val.expiresAt <= now) {
        localRateWindow.delete(key);
      }
    }
  },
  10 * 60 * 1000
).unref();

function localLimit(key, maxEvents, windowSeconds) {
  const now = Date.now();
  const windowMs = Number(windowSeconds) * 1000;
  const current = localRateWindow.get(key);

  if (!current || current.expiresAt <= now) {
    const next = { count: 1, expiresAt: now + windowMs };
    localRateWindow.set(key, next);
    return {
      allowed: true,
      remaining: Math.max(0, maxEvents - 1),
      retryAfterSeconds: windowSeconds,
    };
  }

  current.count += 1;
  localRateWindow.set(key, current);
  return {
    allowed: current.count <= maxEvents,
    remaining: Math.max(0, maxEvents - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.expiresAt - now) / 1000)),
  };
}

async function allowEvent(scope, subjectId, maxEvents, windowSeconds) {
  if (!scope || !subjectId || !maxEvents || !windowSeconds) {
    return { allowed: true, remaining: maxEvents || 0 };
  }

  if (!isRedisReady()) {
    return localLimit(`local:${scope}:${subjectId}`, maxEvents, windowSeconds);
  }

  const key = `rl:${scope}:${subjectId}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }

    return {
      allowed: count <= maxEvents,
      remaining: Math.max(0, maxEvents - count),
      retryAfterSeconds: windowSeconds,
    };
  } catch (err) {
    Logger.warn('rateLimiter', `Redis fallback: ${err.message}`);
    return localLimit(`fallback:${scope}:${subjectId}`, maxEvents, windowSeconds);
  }
}

async function enforceEventLimit(socket, scope, maxEvents, windowSeconds) {
  const subjectId = socket.user?.userId || socket.id;
  const res = await allowEvent(scope, subjectId, maxEvents, windowSeconds);
  if (!res.allowed) {
    return `Rate limit exceeded. Try again in ${res.retryAfterSeconds}s.`;
  }
  return null;
}

module.exports = { allowEvent, enforceEventLimit };
