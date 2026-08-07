const express = require('express');
const router = express.Router();
const fetchImpl = global.fetch ? global.fetch.bind(global) : require('node-fetch');
const rateLimit = require('express-rate-limit');
const verifyToken = require('../utils/tokenUtils').verifyToken;
const Logger = require('../utils/logger');
const {
  recordYoutubeApiError,
  recordYoutubeApiSuccess,
  recordSearchFailure,
} = require('../utils/systemHealth');

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many search requests from this IP, please try again after a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

// in-memory cache
const cache = new Map();
const TTL = 1000 * 60 * 15; // 15 min
const KEY_STATUS_TTL = 1000 * 60 * 5; // 5 min
const MAX_CACHE_SIZE = 100;

router.use((req, _res, next) => {
  Logger.info('route:search', `${req.method} ${req.originalUrl}`);
  next();
});

const keyHealth = {
  checkedAt: 0,
  isValid: false,
  status: 'unknown',
  message: 'Key check not run yet',
};

function parseIsoDurationToSeconds(isoDuration) {
  if (!isoDuration || typeof isoDuration !== 'string') return null;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function parseYouTubeError(rawError) {
  try {
    const parsed = JSON.parse(rawError);
    const message = parsed?.error?.message || rawError;
    const reason = parsed?.error?.errors?.[0]?.reason || null;
    return { message, reason };
  } catch {
    return { message: String(rawError || 'Unknown YouTube API error'), reason: null };
  }
}

async function checkYouTubeApiKey(force = false) {
  const now = Date.now();
  if (!force && now - keyHealth.checkedAt < KEY_STATUS_TTL) {
    return keyHealth;
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    keyHealth.checkedAt = now;
    keyHealth.isValid = false;
    keyHealth.status = 'missing';
    keyHealth.message = 'YOUTUBE_API_KEY is missing';
    return keyHealth;
  }

  try {
    const probeUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=music&key=${apiKey}`;
    const probeResponse = await fetchImpl(probeUrl);

    if (!probeResponse.ok) {
      const rawError = await probeResponse.text();
      const parsedError = parseYouTubeError(rawError);

      // Only mark invalid for real key issues
      const invalidReasons = ['keyInvalid', 'accessNotConfigured'];
      keyHealth.checkedAt = now;
      keyHealth.isValid = !invalidReasons.includes(parsedError.reason);
      keyHealth.status = parsedError.reason || 'invalid';
      keyHealth.message = parsedError.message;

      recordYoutubeApiError(probeResponse.status, parsedError.reason, parsedError.message);
      return keyHealth;
    }

    recordYoutubeApiSuccess();
    keyHealth.checkedAt = now;
    keyHealth.isValid = true;
    keyHealth.status = 'ok';
    keyHealth.message = 'YouTube API key is valid';
    return keyHealth;
  } catch (err) {
    keyHealth.checkedAt = now;
    keyHealth.isValid = false;
    keyHealth.status = 'network_error';
    keyHealth.message = err.message || 'Failed to validate API key';
    return keyHealth;
  }
}

router.get('/key-status', verifyToken, async (_req, res) => {
  const status = await checkYouTubeApiKey(true);
  const httpStatus = status.isValid ? 200 : 503;
  Logger.info('route:search', `key-status valid=${status.isValid} status=${status.status}`);
  return res.status(httpStatus).json(status);
});

router.get('/', verifyToken, searchLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  Logger.info('route:search', `query q="${q.slice(0, 60)}"`);

  if (q.length < 2) {
    return res.status(400).json({ error: 'Query too short' });
  }

  const parsed = Number.parseInt(req.query.maxResults, 10);
  const maxResults = Number.isNaN(parsed) ? 5 : Math.min(Math.max(parsed, 1), 10);

  const keyStatus = await checkYouTubeApiKey();
  if (!keyStatus.isValid) {
    return res.status(502).json({
      error: `YouTube API key check failed: ${keyStatus.message}`,
      keyStatus,
    });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(q)}&key=${apiKey}`;

  const key = Buffer.from(JSON.stringify({ q: q.toLowerCase(), maxResults })).toString('base64');
  const now = Date.now();

  if (cache.has(key)) {
    const entry = cache.get(key);
    if (entry && entry.expires > now) {
      Logger.info('search', `Cache hit q="${q.slice(0, 40)}" count=${entry.results.length}`);
      return res.json({ results: entry.results });
    } else {
      cache.delete(key);
    }
  }

  try {
    Logger.time('search', `youtube:search:${q}`);
    const r = await fetchImpl(searchUrl);
    Logger.timeEnd('search', `youtube:search:${q}`);

    if (!r.ok) {
      const rawError = await r.text();
      const parsedError = parseYouTubeError(rawError);

      recordYoutubeApiError(r.status, parsedError.reason, parsedError.message);

      return res.status(502).json({
        error: parsedError.message,
        reason: parsedError.reason,
      });
    }

    const data = await r.json();
    const items = (data.items || []).filter((i) => i.id?.videoId);

    if (!items.length) {
      return res.json({ results: [] });
    }

    const ids = items.map((i) => i.id.videoId).join(',');
    let durations = {};

    if (ids) {
      const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${apiKey}`;
      const detailsRes = await fetchImpl(detailsUrl);
      const detailsData = await detailsRes.json();

      if (detailsData.items && Array.isArray(detailsData.items)) {
        durations = detailsData.items.reduce((acc, vid) => {
          acc[vid.id] = parseIsoDurationToSeconds(vid.contentDetails.duration);
          return acc;
        }, {});
      }
    }

    const results = items.map((i) => {
      const durationSeconds = durations[i.id.videoId] || null;
      return {
        videoId: i.id.videoId,
        title: i.snippet.title,
        channel_name: i.snippet.channelTitle,
        thumbnail: i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url || '',
        duration_seconds: durationSeconds,
      };
    });

    if (cache.size >= MAX_CACHE_SIZE) {
      for (const [cacheKey, entry] of cache) {
        if (!entry || entry.expires <= now) {
          cache.delete(cacheKey);
        }
      }

      while (cache.size >= MAX_CACHE_SIZE) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
    }

    cache.set(key, { results, expires: now + TTL });

    Logger.info('search', `Upstream results q="${q.slice(0, 40)}" count=${results.length}`);

    return res.json({ results });
  } catch (err) {
    Logger.error('search', `Search error: ${err.message}`, err);
    recordSearchFailure(err.message);
    return res.status(500).json({ error: 'Server error during search' });
  }
});

module.exports = router;
