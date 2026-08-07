const express = require('express');
const router = express.Router();
const { query, runTransactionSync } = require('../db');
const { getCachedQueue, setCachedQueue, invalidateQueue } = require('../utils/redisClient');
const { verifyToken } = require('../utils/tokenUtils');
const queueSocket = require('../sockets/queueHandler');
const Logger = require('../utils/logger');

const MAX_QUEUED_PER_USER = 3;

router.use((req, _res, next) => {
  Logger.info('route:queue', `${req.method} ${req.originalUrl}`);
  next();
});

function normalizePartyCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

// get queue for a party
router.get('/:code', async (req, res) => {
  try {
    const code = normalizePartyCode(req.params.code);
    const cached = await getCachedQueue(code);
    if (cached) {
      Logger.info('route:queue', `cache hit party=${code} songs=${cached.length}`);
      return res.json({ songs: cached });
    }

    // calculate net_score (upvotes - downvotes) and sort accordingly
    const songs = await query(
      `SELECT s.*, 
                    COALESCE(SUM(CASE WHEN v.vote_type='up' THEN 1 WHEN v.vote_type='down' THEN -1 ELSE 0 END),0) AS net_score
             FROM songs s
             LEFT JOIN votes v ON v.song_id = s.song_id
             WHERE s.party_code = ? AND s.status = ?
             GROUP BY s.song_id
             ORDER BY net_score DESC, s.added_at ASC`,
      [code, 'queued']
    );
    await setCachedQueue(code, songs);
    Logger.info('route:queue', `fetched queue party=${code} songs=${songs.length}`);
    return res.json({ songs });
  } catch (err) {
    Logger.error('route:queue', `Get queue error: ${err.message}`, err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DEPRECATED: Client now uses socket.emit('addSong') exclusively (see client/app.js BUG 12 FIX).
// This REST endpoint is kept as an API-only fallback for external integrations.
router.post('/add', verifyToken, async (req, res) => {
  try {
    const {
      partyCode,
      videoId,
      title,
      thumbnail,
      channelName,
      channel_name,
      duration,
      duration_seconds,
      addedBy,
    } = req.body;

    const normalizedPartyCode = normalizePartyCode(partyCode);
    const normalizedVideoId = String(videoId || '').trim();
    const normalizedAddedBy = Number.parseInt(addedBy, 10);

    if (!normalizedPartyCode || !normalizedVideoId || !Number.isInteger(normalizedAddedBy)) {
      return res.status(400).json({ error: 'Missing or invalid required parameters' });
    }

    const normalizedDurationRaw = duration_seconds ?? duration;
    const validDuration = Number(normalizedDurationRaw) || null;
    if (validDuration && (validDuration < 0 || validDuration > 86400)) {
      return res.status(400).json({ error: 'Invalid song duration' });
    }

    const safeTitle =
      String(title || 'Unknown')
        .trim()
        .slice(0, 200) || 'Unknown';
    const safeThumbnail = String(thumbnail || '')
      .trim()
      .slice(0, 500);
    const safeChannelName =
      String(channel_name || channelName || 'Unknown')
        .trim()
        .slice(0, 150) || 'Unknown';

    const result = await runTransactionSync(() => {
      const party = query('SELECT party_code, status FROM parties WHERE party_code = ? LIMIT 1', [
        normalizedPartyCode,
      ]);
      if (!party.length) return { error: 'party_not_found' };
      if (party[0].status !== 'active') return { error: 'party_inactive' };

      const user = query(
        'SELECT user_id, role FROM users WHERE user_id = ? AND party_code = ? LIMIT 1',
        [normalizedAddedBy, normalizedPartyCode]
      );
      if (!user.length) return { error: 'user_not_auth' };

      if (user[0].role !== 'host') {
        const queuedByUser = query(
          'SELECT COUNT(*) AS cnt FROM songs WHERE added_by = ? AND party_code = ? AND status = ? ',
          [normalizedAddedBy, normalizedPartyCode, 'queued']
        );
        if ((queuedByUser?.[0]?.cnt || 0) >= MAX_QUEUED_PER_USER) return { error: 'limit_reached' };
      }

      const duplicate = query(
        'SELECT 1 FROM songs WHERE video_id = ? AND party_code = ? AND status = ? LIMIT 1',
        [normalizedVideoId, normalizedPartyCode, 'queued']
      );
      if (duplicate.length) return { error: 'duplicate' };

      const insertResult = query(
        'INSERT INTO songs (party_code, video_id, title, thumbnail, channel_name, duration_seconds, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          normalizedPartyCode,
          normalizedVideoId.slice(0, 100),
          safeTitle,
          safeThumbnail,
          safeChannelName,
          validDuration,
          normalizedAddedBy,
        ]
      );
      return { success: true, songId: insertResult.insertId };
    });

    if (result.error === 'party_not_found')
      return res.status(404).json({ error: 'Party not found' });
    if (result.error === 'party_inactive')
      return res.status(400).json({ error: 'Party is not active' });
    if (result.error === 'user_not_auth')
      return res.status(403).json({ error: 'User is not part of this party' });
    if (result.error === 'limit_reached')
      return res.status(400).json({ error: `Max ${MAX_QUEUED_PER_USER} songs allowed` });
    if (result.error === 'duplicate')
      return res.status(409).json({ error: 'Song already in queue' });

    Logger.info(
      'route:queue',
      `song added party=${normalizedPartyCode} songId=${result.songId} addedBy=${normalizedAddedBy} videoId=${normalizedVideoId.slice(0, 20)}`
    );

    await invalidateQueue(normalizedPartyCode);

    const io = req.app.get('io');
    if (io) {
      const startedPlayback = await queueSocket.ensurePlaybackStarted(io, normalizedPartyCode);
      if (!startedPlayback) {
        await queueSocket.emitQueueUpdate(io, normalizedPartyCode);
      }
    }

    return res.json({ songId: result.songId });
  } catch (err) {
    Logger.error('route:queue', `Add song error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// export playlist as JSON
router.get('/export/:code', async (req, res) => {
  try {
    const code = normalizePartyCode(req.params.code);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isNaN(parsedLimit) ? 500 : Math.min(Math.max(parsedLimit, 1), 2000);
    const songs = await query(
      'SELECT video_id, title, channel_name, duration_seconds FROM songs WHERE party_code = ? ORDER BY added_at ASC LIMIT ?',
      [code, limit]
    );
    res.json({
      partyCode: code,
      exportedAt: new Date().toISOString(),
      songs: songs,
      limit,
    });
    Logger.info('route:queue', `exported party=${code} count=${songs.length} limit=${limit}`);
  } catch (err) {
    Logger.error('route:queue', `Export error: ${err.message}`, err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
