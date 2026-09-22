const express = require('express');
const router = express.Router();
const { query, runTransactionSync } = require('../db');
const { verifyToken } = require('../utils/tokenUtils');
const { invalidateQueue } = require('../utils/redisClient');
const Logger = require('../utils/logger');

router.use((req, _res, next) => {
  Logger.info('route:vote', `${req.method} ${req.originalUrl}`);
  next();
});

// DEPRECATED: Client now uses socket.emit('voteSong') exclusively.
// This REST endpoint is kept as an API-only fallback for external integrations.
router.post('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const partyCode = req.user.partyCode;
    const { songId, voteType } = req.body;
    Logger.info('route:vote', `incoming userId=${userId} songId=${songId} voteType=${voteType}`);

    // Validate input
    if (!songId || !['up', 'down'].includes(voteType)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const normalizedSongId = Number.parseInt(songId, 10);
    if (!Number.isInteger(normalizedSongId)) {
      return res.status(400).json({ error: 'Invalid songId' });
    }

    // Verify song belongs to user's party
    const songRows = await query(
      'SELECT 1 FROM songs WHERE song_id = ? AND party_code = ? LIMIT 1',
      [normalizedSongId, partyCode]
    );
    if (!songRows.length) {
      return res.status(404).json({ error: 'Song not found in your party' });
    }

    // Toggle logic aligned with socket voteSong handler:
    // same vote => remove, different vote => switch, no vote => insert.
    const action = runTransactionSync(() => {
      const exists = query('SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ? LIMIT 1', [
        userId,
        normalizedSongId,
      ]);

      if (exists.length > 0) {
        const current = exists[0].vote_type;
        if (current === voteType) {
          query('DELETE FROM votes WHERE user_id = ? AND song_id = ?', [
            userId,
            normalizedSongId,
          ]);
          return 'removed';
        } else {
          query('UPDATE votes SET vote_type = ? WHERE user_id = ? AND song_id = ?', [
            voteType,
            userId,
            normalizedSongId,
          ]);
          return 'updated';
        }
      } else {
        query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [
          userId,
          normalizedSongId,
          voteType,
        ]);
        return 'created';
      }
    });

    Logger.info(
      'route:vote',
      `${action} userId=${userId} songId=${normalizedSongId} voteType=${voteType}`
    );

    // Invalidate cache and broadcast queue update through Socket.IO
    await invalidateQueue(partyCode);
    const io = req.app.get('io');
    if (io) {
      const queueHandler = require('../sockets/queueHandler');
      await queueHandler.emitQueueUpdate(io, partyCode);
    }

    return res.json({ success: true, action });
  } catch (err) {
    Logger.error('route:vote', `Vote error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

module.exports = router;
