const express = require('express');
const router = express.Router();
const youtubedl = require('youtube-dl-exec');
const fetch = require('node-fetch');
const { isRedisReady, redis } = require('../utils/redisClient');
const Logger = require('../utils/logger');
const { recordStreamFailure, recordStreamSuccess } = require('../utils/systemHealth');
const { isValidVideoId } = require('../utils/validators');

const STREAM_CACHE_TTL = 7200; // 2 hours (YouTube direct URLs typically expire after ~6h)

/**
 * Cache yt-dlp output (direct URL + headers + filesize + duration) to avoid redundant calls.
 * On cache hit, yt-dlp is skipped entirely.
 */
async function getCachedStreamInfo(videoId) {
  if (!isRedisReady()) return null;
  try {
    const data = await redis.get(`stream:direct:${videoId}`);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

async function setCachedStreamInfo(videoId, info) {
  if (!isRedisReady()) return;
  try {
    await redis.setex(`stream:direct:${videoId}`, STREAM_CACHE_TTL, JSON.stringify(info));
  } catch (err) {
    Logger.warn('stream', `Failed to cache stream info for ${videoId}: ${err.message}`);
  }
}

router.get('/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const { start } = req.query;

  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  try {
    const cached = await getCachedStreamInfo(videoId);
    let directMediaUrl;
    let httpHeaders;
    let filesize = 0;
    let duration = 0;

    if (cached?.url) {
      Logger.info('stream', `Cache hit for ${videoId}, skipping yt-dlp`);
      directMediaUrl = cached.url;
      httpHeaders = cached.httpHeaders || {};
      filesize = cached.filesize || 0;
      duration = cached.duration || 0;
    } else {
      Logger.info('stream', `Fetching yt-dlp metadata for ${videoId}`);
      const url = `https://www.youtube.com/watch?v=${videoId}`;

      const output = await youtubedl(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        noCheckCertificate: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        format: 'bestaudio',
      });

      if (!output.url) {
        throw new Error('No direct playable media format available');
      }

      directMediaUrl = output.url;
      httpHeaders = output.http_headers || {};
      filesize = Number(output.filesize || output.filesize_approx || 0);
      duration = Number(output.duration || 0);

      // If yt-dlp didn't return filesize, probe the direct URL with a HEAD request
      if (!filesize && directMediaUrl) {
        try {
          const headHeaders = {
            'User-Agent': httpHeaders['User-Agent'] || 'Mozilla/5.0',
            Referer: 'https://www.youtube.com/',
            Origin: 'https://www.youtube.com',
          };
          const headRes = await fetch(directMediaUrl, { method: 'HEAD', headers: headHeaders });
          const cl = Number(headRes.headers.get('content-length') || 0);
          if (cl > 0) {
            filesize = cl;
            Logger.info('stream', `HEAD probe got filesize=${filesize} for ${videoId}`);
          }
        } catch (headErr) {
          Logger.warn('stream', `HEAD probe failed for ${videoId}: ${headErr.message}`);
        }
      }

      // If yt-dlp didn't return duration, look it up from the DB
      if (!duration) {
        try {
          const { query } = require('../db');
          const rows = query(
            'SELECT duration_seconds FROM songs WHERE video_id = ? AND duration_seconds > 0 ORDER BY song_id DESC LIMIT 1',
            [videoId]
          );
          if (rows.length && Number(rows[0].duration_seconds) > 0) {
            duration = Number(rows[0].duration_seconds);
            Logger.info('stream', `DB fallback got duration=${duration}s for ${videoId}`);
          }
        } catch (dbErr) {
          Logger.warn('stream', `DB duration lookup failed for ${videoId}: ${dbErr.message}`);
        }
      }

      // Cache the direct URL, headers, filesize, and duration for future requests
      await setCachedStreamInfo(videoId, {
        url: directMediaUrl,
        httpHeaders,
        filesize,
        duration,
      });
    }

    const rawStart = Number(start);
    const seekSeconds = Number.isFinite(rawStart) && rawStart > 0 ? Math.floor(rawStart) : 0;

    // When we need to seek but cached entry is missing filesize/duration, try to enrich it
    if (seekSeconds > 0 && (!filesize || !duration)) {
      const enrichHeaders = {
        'User-Agent': httpHeaders?.['User-Agent'] || 'Mozilla/5.0',
        Referer: 'https://www.youtube.com/',
        Origin: 'https://www.youtube.com',
      };

      if (!filesize && directMediaUrl) {
        try {
          const headRes = await fetch(directMediaUrl, { method: 'HEAD', headers: enrichHeaders });
          const cl = Number(headRes.headers.get('content-length') || 0);
          if (cl > 0) {
            filesize = cl;
            Logger.info('stream', `Seek-time HEAD probe got filesize=${filesize} for ${videoId}`);
          }
        } catch {
          /* ignore */
        }
      }

      if (!duration) {
        try {
          const { query } = require('../db');
          const rows = query(
            'SELECT duration_seconds FROM songs WHERE video_id = ? AND duration_seconds > 0 ORDER BY song_id DESC LIMIT 1',
            [videoId]
          );
          if (rows.length && Number(rows[0].duration_seconds) > 0) {
            duration = Number(rows[0].duration_seconds);
            Logger.info('stream', `Seek-time DB fallback got duration=${duration}s for ${videoId}`);
          }
        } catch {
          /* ignore */
        }
      }

      // Update cache with enriched data so future requests don't need HEAD again
      if (filesize || duration) {
        await setCachedStreamInfo(videoId, {
          url: directMediaUrl,
          httpHeaders,
          filesize,
          duration,
        });
      }
    }

    // Build upstream fetch headers
    const upstreamHeaders = {
      'User-Agent':
        httpHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: httpHeaders['Accept'] || '*/*',
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
    };

    // ──────────────────────────────────────────────────────────────────
    // BYTE-RANGE SEEKING: YouTube CDN ignores the `?begin=` param for
    // single-file audio formats (webm/opus, m4a). Instead we calculate
    // the byte offset from the time position and use an HTTP Range header.
    // This is the only reliable way to seek inside a proxied stream.
    // ──────────────────────────────────────────────────────────────────
    if (seekSeconds > 0 && filesize > 0 && duration > 0) {
      const ratio = Math.min(seekSeconds / duration, 0.99);
      const byteOffset = Math.floor(ratio * filesize);
      upstreamHeaders['Range'] = `bytes=${byteOffset}-`;
      Logger.info(
        'stream',
        `Byte-range seek: video=${videoId} seekSec=${seekSeconds} duration=${duration} filesize=${filesize} byteOffset=${byteOffset}`
      );
    } else if (seekSeconds > 0) {
      // Fallback: If we still don't have filesize/duration after enrichment, try legacy begin param
      Logger.warn(
        'stream',
        `No filesize/duration for ${videoId} after enrichment, falling back to ?begin=`
      );
      const finalUrl = new URL(directMediaUrl);
      finalUrl.searchParams.set('begin', String(Math.floor(seekSeconds * 1000)));
      directMediaUrl = finalUrl.toString();
    }

    // Proxy the stream using the headers from yt-dlp
    const upstream = await fetch(directMediaUrl, { headers: upstreamHeaders });

    if (!upstream.ok || !upstream.body) {
      // If a cached URL returned 403/410, invalidate cache and retry
      if (cached?.url) {
        Logger.warn(
          'stream',
          `Cached URL expired for ${videoId} (status=${upstream.status}), invalidating`
        );
        if (isRedisReady()) await redis.del(`stream:direct:${videoId}`);
      }
      throw new Error(`Direct media fetch failed with status ${upstream.status}`);
    }

    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    // Pass the seek offset to the client so it can adjust currentTime calculations
    if (seekSeconds > 0) {
      res.setHeader('X-Audio-Start-Seconds', String(seekSeconds));
    }

    upstream.body.on('error', (err) => {
      Logger.error('stream', `Upstream media stream error: ${err.message}`, err);
      if (!res.headersSent) res.status(500).end();
    });

    res.on('close', () => {
      if (upstream?.body && typeof upstream.body.destroy === 'function') {
        upstream.body.destroy();
      }
    });

    upstream.body.pipe(res);
    recordStreamSuccess();
  } catch (err) {
    recordStreamFailure(videoId, err.message);
    Logger.error('stream', `yt-dlp route CRITICAL failure for ${videoId}: ${err.message}`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Streaming failed', details: err.message });
    }
  }
});

module.exports = router;
