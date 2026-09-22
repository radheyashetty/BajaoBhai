const { query, runTransactionSync } = require('../db');
const {
  getCachedQueue,
  setCachedQueue,
  invalidateQueue,
  getNowPlayingState,
  setNowPlayingState,
  clearNowPlayingState,
} = require('../utils/redisClient');
const { allowEvent } = require('../utils/rateLimiter');
const { emitPartyUserListIfChanged } = require('./userListBroadcast');
const Logger = require('../utils/logger');
const { isValidVideoId } = require('../utils/validators');

const QUEUE_WITH_SCORES_SQL = `
  SELECT s.*,
    COALESCE(SUM(
      CASE
        WHEN v.vote_type='up' THEN 1
        WHEN v.vote_type='down' THEN -1
        ELSE 0
      END
    ),0) AS net_score
  FROM songs s
  LEFT JOIN votes v ON v.song_id = s.song_id
  WHERE s.party_code = ? AND s.status = 'queued'
  GROUP BY s.song_id
  ORDER BY net_score DESC, s.added_at ASC
`;

const NEXT_QUEUED_SONG_SQL = `${QUEUE_WITH_SCORES_SQL}\nLIMIT 1`;
function qLog(message) {
  Logger.info('socket:queue', message);
}

/* ================= LOCK (QUEUE BASED) ================= */
const partyLocks = new Map();
const safetyTimers = new Map();

function clearSafetyTimer(partyCode) {
  if (safetyTimers.has(partyCode)) {
    clearTimeout(safetyTimers.get(partyCode));
    safetyTimers.delete(partyCode);
    qLog(`clearSafetyTimer party=${partyCode}`);
  }
}

function scheduleSafetyTimer(io, partyCode, song, offsetSeconds = 0) {
  clearSafetyTimer(partyCode);

  const duration = Number(song.duration_seconds) || 0;
  if (duration <= 0) return; // Cannot safely auto-advance without duration

  const remaining = duration - offsetSeconds;
  // Buffer: duration + 5 seconds grace period
  const ms = Math.max(0, (remaining + 5) * 1000);

  qLog(
    `scheduleSafetyTimer party=${partyCode} songId=${song.song_id} in=${ms}ms (offset=${offsetSeconds}s)`
  );

  const t = setTimeout(async () => {
    try {
      qLog(`safetyTimer TRIGGERED party=${partyCode} songId=${song.song_id}`);
      await skipSongAndAdvance(io, partyCode, song.song_id);
    } catch (err) {
      Logger.error('queue', `safetyTimer execution error party=${partyCode}: ${err.message}`, err);
    }
  }, ms);
  t.unref();

  safetyTimers.set(partyCode, t);
}

async function withPartyLock(partyCode, fn) {
  const prev = partyLocks.get(partyCode) || Promise.resolve();

  const next = prev.catch(() => {}).then(fn);

  partyLocks.set(partyCode, next);

  try {
    return await next;
  } finally {
    if (partyLocks.get(partyCode) === next) {
      partyLocks.delete(partyCode);
    }
  }
}

/* ================= HELPERS ================= */

async function validateSongBelongsToParty(songId, partyCode, status = null) {
  const sql = status
    ? 'SELECT 1 FROM songs WHERE song_id = ? AND party_code = ? AND status = ? LIMIT 1'
    : 'SELECT 1 FROM songs WHERE song_id = ? AND party_code = ? LIMIT 1';
  const params = status ? [songId, partyCode, status] : [songId, partyCode];
  const rows = await query(sql, params);
  return rows.length > 0;
}

async function ensurePartyActive(partyCode) {
  const rows = await query('SELECT status FROM parties WHERE party_code = ? LIMIT 1', [partyCode]);
  return rows.length > 0 && rows[0].status === 'active';
}

async function getUpdatedQueue(partyCode) {
  const cached = await getCachedQueue(partyCode);
  if (cached) return cached;

  const songs = await query(QUEUE_WITH_SCORES_SQL, [partyCode]);

  await setCachedQueue(partyCode, songs);
  return songs;
}

async function getOnlineGuestCount(partyCode) {
  const rows = await query(
    "SELECT COUNT(*) AS cnt FROM users WHERE party_code = ? AND role='guest' AND is_online=1",
    [partyCode]
  );
  return rows?.[0]?.cnt || 0;
}

async function _startNextSong_NoLock(io, partyCode) {
  const next = await query(NEXT_QUEUED_SONG_SQL, [partyCode]);

  if (!next.length) {
    qLog(`startNextSong no-next party=${partyCode}`);
    await clearNowPlayingState(partyCode);
    io.to(partyCode).emit('playbackControl', {
      action: 'stop',
      songId: null,
      hostTimestamp: Date.now(),
    });
    return null;
  }

  const song = next[0];

  runTransactionSync([
    {
      sql: "UPDATE songs SET status='played' WHERE party_code=? AND status='playing'",
      values: [partyCode],
    },
    {
      sql: "UPDATE songs SET status='playing' WHERE song_id=?",
      values: [song.song_id],
    },
  ]);

  qLog(`startNextSong selected party=${partyCode} songId=${song.song_id}`);

  return song;
}

async function startNextSong(io, partyCode) {
  return withPartyLock(partyCode, () => _startNextSong_NoLock(io, partyCode));
}

async function calculateSkipThreshold(partyCode) {
  const guests = await getOnlineGuestCount(partyCode);
  return Math.floor(guests / 2) + 1;
}

async function getSkipVoteCount(songId) {
  const [{ cnt }] = await query('SELECT COUNT(*) AS cnt FROM skip_votes WHERE song_id=?', [songId]);
  return Number(cnt) || 0;
}

async function emitQueueUpdate(io, partyCode) {
  const queue = await getUpdatedQueue(partyCode);
  io.to(partyCode).emit('queueUpdate', { songs: queue });
  qLog(`queueUpdate party=${partyCode} songs=${queue.length}`);
  return queue;
}

async function emitQueueUpdateToSocket(socket, partyCode) {
  const queue = await getUpdatedQueue(partyCode);
  socket.emit('queueUpdate', { songs: queue });
  qLog(`queueUpdateToSocket party=${partyCode} socketId=${socket.id} songs=${queue.length}`);
  return queue;
}

async function checkRateLimit(socket, scope, maxEvents, windowSeconds) {
  const partyCode = socket.user?.partyCode;
  const userId = socket.user?.userId;
  if (!partyCode || !userId) return false;

  const decision = await allowEvent(
    scope,
    `${String(partyCode).toUpperCase()}:${String(userId)}`,
    maxEvents,
    windowSeconds
  );
  if (decision.allowed) return false;

  socket.emit('actionError', {
    message: 'Too many actions too quickly. Please wait a moment and try again.',
  });
  return true;
}

async function emitNowPlaying(io, partyCode, song, startedAt = Date.now()) {
  const skipThreshold = await calculateSkipThreshold(partyCode);

  await setNowPlayingState(partyCode, {
    songId: song.song_id,
    startedAt,
    isPlaying: true,
    lastProgressSeconds: 0,
    skipThreshold,
    skipThresholdComputedAt: Date.now(),
  });

  const durationSeconds = Number(song.duration_seconds) || 0;
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000)
  );
  const resumeSeconds =
    durationSeconds > 0
      ? Math.min(elapsedSeconds, Math.max(durationSeconds - 1, 0))
      : elapsedSeconds;

  io.to(partyCode).emit('nowPlaying', {
    song,
    startedAt,
    durationSeconds: song.duration_seconds,
    resumeSeconds,
    isPlaying: true,
  });
  qLog(`nowPlaying party=${partyCode} songId=${song.song_id} startedAt=${startedAt}`);

  // Schedule server-side safety skip in case host client hangs
  scheduleSafetyTimer(io, partyCode, song, resumeSeconds);

  io.to(partyCode).emit('skipVoteUpdate', {
    songId: song.song_id,
    count: await getSkipVoteCount(song.song_id),
    needed: skipThreshold,
  });

  await emitQueueUpdate(io, partyCode);
}

async function emitCurrentNowPlayingToSocket(socket, partyCode) {
  const songs = await query('SELECT * FROM songs WHERE party_code = ? AND status = ? LIMIT 1', [
    partyCode,
    'playing',
  ]);

  if (!songs.length) {
    socket.emit('playbackControl', {
      action: 'stop',
      songId: null,
      hostTimestamp: Date.now(),
    });
    qLog(`syncNowPlaying party=${partyCode} no-current-song`);
    return;
  }

  const song = songs[0];
  const nowPlayingState = await getNowPlayingState(partyCode);
  const startedAt = Number(nowPlayingState?.startedAt) || Date.now();
  const isPlaying = nowPlayingState?.isPlaying !== false;
  const lastProgressSeconds = Number(nowPlayingState?.lastProgressSeconds || 0);
  const durationSeconds = Number(song.duration_seconds) || 0;
  const elapsedSeconds = isPlaying
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : Math.max(0, Math.floor(lastProgressSeconds));
  const resumeSeconds =
    durationSeconds > 0
      ? Math.min(elapsedSeconds, Math.max(durationSeconds - 1, 0))
      : elapsedSeconds;

  socket.emit('nowPlaying', {
    song,
    startedAt,
    isPlaying,
    durationSeconds: song.duration_seconds,
    resumeSeconds,
  });
  qLog(`syncNowPlaying party=${partyCode} socketId=${socket.id} songId=${song.song_id}`);
}

async function ensurePlaybackStarted(io, partyCode) {
  const current = await query(
    'SELECT song_id FROM songs WHERE party_code = ? AND status = ? LIMIT 1',
    [partyCode, 'playing']
  );

  if (current.length) {
    qLog(
      `ensurePlaybackStarted skipped party=${partyCode} reason=already-playing songId=${current[0].song_id}`
    );
    return false;
  }

  const next = await startNextSong(io, partyCode);
  if (!next) {
    qLog(`ensurePlaybackStarted skipped party=${partyCode} reason=no-queued-song`);
    return false;
  }

  await emitNowPlaying(io, partyCode, next);
  qLog(`ensurePlaybackStarted started party=${partyCode} songId=${next.song_id}`);
  return true;
}

async function _skipSongAndAdvance_NoLock(io, partyCode, songId) {
  const current = await query(
    'SELECT status FROM songs WHERE song_id = ? AND party_code = ? LIMIT 1',
    [songId, partyCode]
  );
  if (!current.length || current[0].status !== 'playing') {
    qLog(`skipSongAndAdvance aborted-stale party=${partyCode} songId=${songId}`);
    return;
  }

  qLog(`skipSongAndAdvance party=${partyCode} songId=${songId}`);
  clearSafetyTimer(partyCode);
  runTransactionSync([
    { sql: "UPDATE songs SET status='skipped' WHERE song_id=?", values: [songId] },
    { sql: 'DELETE FROM skip_votes WHERE song_id=?', values: [songId] },
  ]);

  await invalidateQueue(partyCode);

  const next = await _startNextSong_NoLock(io, partyCode);
  if (next) {
    await emitNowPlaying(io, partyCode, next);
  } else {
    qLog(`skipSongAndAdvance no-next party=${partyCode}`);
  }
}

async function skipSongAndAdvance(io, partyCode, songId) {
  return withPartyLock(partyCode, () => _skipSongAndAdvance_NoLock(io, partyCode, songId));
}

/* ================= SOCKET HANDLER ================= */

module.exports = (io, socket) => {
  socket.on('relinquishHost', async () => {
    try {
      const partyCode = socket.user?.partyCode;
      const currentUserId = Number(socket.user?.userId);
      if (!partyCode || !currentUserId) return;
      if (socket.user?.role !== 'host') {
        return socket.emit('actionError', { message: 'Only host can transfer host role' });
      }

      const candidates = await query(
        'SELECT user_id, username, socket_id FROM users WHERE party_code = ? AND role = ? AND is_online = 1 AND user_id != ? ORDER BY joined_at ASC LIMIT 1',
        [partyCode, 'guest', currentUserId]
      );

      if (!candidates.length) {
        return socket.emit('actionError', { message: 'No online guest available to become host' });
      }

      const nextHost = candidates[0];

      runTransactionSync([
        { sql: "UPDATE users SET role = 'guest' WHERE user_id = ?", values: [currentUserId] },
        { sql: "UPDATE users SET role = 'host' WHERE user_id = ?", values: [nextHost.user_id] },
        {
          sql: 'UPDATE parties SET host_user_id = ? WHERE party_code = ?',
          values: [nextHost.user_id, partyCode],
        },
      ]);

      socket.user.role = 'guest';

      if (nextHost.socket_id) {
        const promotedSocket = io.sockets.sockets.get(nextHost.socket_id);
        if (promotedSocket?.user) {
          promotedSocket.user.role = 'host';
        }
      }

      io.to(partyCode).emit('hostChanged', {
        newHostId: nextHost.user_id,
        newHostUsername: nextHost.username,
        reason: 'host-relinquish',
      });

      if (nextHost.socket_id) {
        io.to(nextHost.socket_id).emit('hostGranted', {
          partyCode,
          userId: nextHost.user_id,
        });
      }

      const users = await query(
        'SELECT user_id AS userId, username, role, avatar_color AS avatarColor FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
        [partyCode]
      );
      emitPartyUserListIfChanged(io, partyCode, users);
      qLog(
        `relinquishHost party=${partyCode} fromUserId=${currentUserId} toUserId=${nextHost.user_id}`
      );
    } catch (err) {
      Logger.error('queue', `relinquishHost error: ${err.message}`, err);
      socket.emit('actionError', { message: 'Failed to transfer host role' });
    }
  });

  socket.on('hostPlaybackControl', async ({ action, songId, position }) => {
    try {
      const partyCode = socket.user?.partyCode;
      if (!partyCode) return;
      if (await checkRateLimit(socket, 'host-playback-control', 20, 10)) return;
      if (socket.user?.role !== 'host') {
        return socket.emit('actionError', { message: 'Only host can control playback' });
      }

      const normalizedAction = String(action || '').toLowerCase();
      if (!['play', 'pause', 'seek'].includes(normalizedAction)) return;

      const safePosition = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : null;
      qLog(
        `hostPlaybackControl party=${partyCode} action=${normalizedAction} hostUserId=${socket.user.userId} songId=${songId || 'n/a'} position=${safePosition ?? 'n/a'}`
      );

      // If host presses play while nothing is marked playing, boot playback from queue.
      if (normalizedAction === 'play') {
        const current = await query(
          'SELECT song_id FROM songs WHERE party_code = ? AND status = ? LIMIT 1',
          [partyCode, 'playing']
        );

        if (!current.length) {
          const startedPlayback = await ensurePlaybackStarted(io, partyCode);
          if (!startedPlayback) {
            return socket.emit('actionError', { message: 'Queue is empty. Add a song first.' });
          }
        }
      }

      const activePlaying = await query(
        'SELECT * FROM songs WHERE party_code = ? AND status = ? LIMIT 1',
        [partyCode, 'playing']
      );
      if (!activePlaying.length) {
        return socket.emit('actionError', { message: 'No active song to control' });
      }

      const activeSongId = Number(activePlaying[0].song_id);
      const requestedSongId = Number.parseInt(songId, 10);
      if (Number.isInteger(requestedSongId) && requestedSongId !== activeSongId) {
        socket.emit('actionError', { message: 'Playback changed. Syncing current song.' });
        await emitCurrentNowPlayingToSocket(socket, partyCode);
        return;
      }

      const nowPlayingState = await getNowPlayingState(partyCode);
      if (nowPlayingState) {
        const currentEstimatedSeconds = Math.max(
          0,
          Math.floor((Date.now() - Number(nowPlayingState.startedAt || Date.now())) / 1000)
        );
        const nextProgressSeconds = safePosition !== null ? safePosition : currentEstimatedSeconds;
        let nextIsPlaying = nowPlayingState.isPlaying;
        if (normalizedAction === 'play') nextIsPlaying = true;
        if (normalizedAction === 'pause') nextIsPlaying = false;
        // Seek keeps the current playing state (should remain playing)
        if (normalizedAction === 'seek') nextIsPlaying = nowPlayingState.isPlaying !== false;

        // Always recalculate startedAt from position for accurate sync baseline
        const nextStartedAt = Date.now() - Math.floor(Math.max(0, nextProgressSeconds) * 1000);

        await setNowPlayingState(partyCode, {
          ...nowPlayingState,
          isPlaying: nextIsPlaying,
          lastProgressSeconds: Math.max(0, nextProgressSeconds),
          startedAt: nextStartedAt,
        });

        // Update technical safety timer
        if (normalizedAction === 'pause') {
          clearSafetyTimer(partyCode);
        } else {
          scheduleSafetyTimer(io, partyCode, activePlaying[0], nextProgressSeconds);
        }
      }

      io.to(partyCode).emit('playbackControl', {
        action: normalizedAction,
        songId: activeSongId,
        position: safePosition,
        hostTimestamp: Date.now(),
        byUserId: socket.user.userId,
      });
      qLog(`playbackControl emitted party=${partyCode} action=${normalizedAction}`);
    } catch (err) {
      Logger.error('queue', `hostPlaybackControl error: ${err.message}`, err);
      socket.emit('actionError', { message: 'Failed to control playback' });
    }
  });

  socket.on('songEnded', async ({ songId }) => {
    try {
      const partyCode = socket.user?.partyCode;
      if (!partyCode) return;
      if (await checkRateLimit(socket, 'song-ended', 8, 20)) return;
      if (socket.user?.role !== 'host') return;
      if (!(await ensurePartyActive(partyCode))) return;

      let resolvedSongId = Number.parseInt(songId, 10);
      const currentPlaying = await query(
        'SELECT song_id FROM songs WHERE party_code = ? AND status = ? LIMIT 1',
        [partyCode, 'playing']
      );

      if (!currentPlaying.length) return;
      const currentPlayingSongId = Number(currentPlaying[0].song_id);

      if (!Number.isInteger(resolvedSongId)) {
        resolvedSongId = currentPlayingSongId;
      }

      // Ignore stale end events for songs that are no longer active.
      if (resolvedSongId !== currentPlayingSongId) {
        qLog(
          `songEnded ignored-stale party=${partyCode} hostUserId=${socket.user.userId} endedSongId=${resolvedSongId} currentSongId=${currentPlayingSongId}`
        );
        return;
      }

      await skipSongAndAdvance(io, partyCode, resolvedSongId);
      qLog(
        `songEnded advanced party=${partyCode} hostUserId=${socket.user.userId} songId=${resolvedSongId}`
      );
    } catch (err) {
      Logger.error('queue', `songEnded error: ${err.message}`, err);
    }
  });

  /* ================= ADD SONG ================= */
  socket.on('addSong', async (data) => {
    try {
      if (!socket.user?.partyCode) return;
      if (await checkRateLimit(socket, 'add-song', 8, 30)) return;

      const { videoId, title, thumbnail, channelName, channel_name, duration, duration_seconds } =
        data;
      const partyCode = socket.user.partyCode;
      const userId = socket.user.userId;

      if (!(await ensurePartyActive(partyCode))) {
        return socket.emit('actionError', { message: 'Party is not active' });
      }

      if (!videoId || !isValidVideoId(videoId)) {
        return socket.emit('actionError', { message: 'Invalid video ID format' });
      }

      const normalizedChannelName =
        String(channel_name || channelName || 'Unknown')
          .replace(/[<>]/g, '')
          .trim()
          .slice(0, 150) || 'Unknown';
      const safeTitle =
        String(title || 'Unknown')
          .replace(/[<>]/g, '')
          .trim()
          .slice(0, 200) || 'Unknown';
      const safeThumbnail = String(thumbnail || '')
        .trim()
        .slice(0, 500);
      const parsedDuration = Number(duration_seconds ?? duration ?? 0);
      const safeDuration =
        Number.isFinite(parsedDuration) && parsedDuration >= 0 && parsedDuration <= 86400
          ? Math.floor(parsedDuration)
          : 0;

      const result = runTransactionSync(() => {
        const userRow = query('SELECT role FROM users WHERE user_id = ? LIMIT 1', [userId]);
        if (!userRow.length) return { error: 'user_not_auth' };

        if (userRow[0].role !== 'host') {
          const countRow = query(
            "SELECT COUNT(*) AS cnt FROM songs WHERE added_by=? AND party_code=? AND status='queued'",
            [userId, partyCode]
          );
          if (countRow[0].cnt >= 3) return { error: 'max_reached' };
        }

        const duplicate = query(
          "SELECT 1 FROM songs WHERE video_id=? AND party_code=? AND status='queued'",
          [videoId, partyCode]
        );
        if (duplicate.length) return { error: 'duplicate' };

        const insert = query(
          `
          INSERT INTO songs 
          (party_code, video_id, title, thumbnail, channel_name, duration_seconds, added_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          [
            partyCode,
            videoId,
            safeTitle,
            safeThumbnail,
            normalizedChannelName,
            safeDuration,
            userId,
          ]
        );

        return { success: true, songId: insert.insertId };
      });

      if (result.error === 'max_reached') {
        return socket.emit('songAddFailed', { message: 'Max 3 songs allowed' });
      }
      if (result.error === 'duplicate') {
        return socket.emit('songAddFailed', { message: 'Song already in queue' });
      }

      qLog(
        `addSong party=${partyCode} userId=${userId} videoId=${String(videoId || '').slice(0, 20)} title=${String(title || '').slice(0, 50)}`
      );

      await invalidateQueue(partyCode);
      const startedPlayback = await ensurePlaybackStarted(io, partyCode);
      if (!startedPlayback) {
        await emitQueueUpdate(io, partyCode);
      }
    } catch (err) {
      Logger.error('queue', `addSong error: ${err.message}`, err);
    }
  });

  /* ================= VOTE ================= */
  socket.on('voteSong', async ({ songId, voteType }) => {
    try {
      const partyCode = socket.user?.partyCode;
      const userId = socket.user?.userId;
      const normalizedSongId = Number.parseInt(songId, 10);
      if (!partyCode || !Number.isInteger(normalizedSongId) || !['up', 'down'].includes(voteType)) return;
      if (await checkRateLimit(socket, 'vote-song', 20, 10)) return;
      if (!(await ensurePartyActive(partyCode))) return;

      if (!(await validateSongBelongsToParty(normalizedSongId, partyCode, 'queued'))) return;

      runTransactionSync(() => {
        const existing = query(
          'SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ? LIMIT 1',
          [userId, normalizedSongId]
        );

        if (existing.length > 0 && existing[0].vote_type === voteType) {
          query('DELETE FROM votes WHERE user_id = ? AND song_id = ?', [userId, normalizedSongId]);
        } else {
          query(
            `
            INSERT INTO votes (user_id, song_id, vote_type)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, song_id) DO UPDATE SET vote_type=excluded.vote_type
          `,
            [userId, normalizedSongId, voteType]
          );
        }
      });

      await invalidateQueue(partyCode);
      await emitQueueUpdate(io, partyCode);

      qLog(`voteSong party=${partyCode} userId=${userId} songId=${normalizedSongId} voteType=${voteType}`);
    } catch (err) {
      Logger.error('queue', `voteSong error: ${err.message}`, err);
    }
  });

  /* ================= SKIP ================= */
  socket.on('skipSong', async (payload = {}) => {
    try {
      const partyCode = socket.user?.partyCode;
      if (!partyCode) return;
      if (await checkRateLimit(socket, 'skip-song', 8, 15)) return;
      if (socket.user?.role !== 'host') {
        return socket.emit('actionError', { message: 'Only host can skip directly' });
      }
      if (!(await ensurePartyActive(partyCode))) return;

      let songId = Number.parseInt(payload.songId, 10);
      if (!Number.isInteger(songId)) {
        const currentPlaying = await query(
          'SELECT song_id FROM songs WHERE party_code = ? AND status = ? LIMIT 1',
          [partyCode, 'playing']
        );
        if (!currentPlaying.length) {
          return socket.emit('actionError', { message: 'No active song to skip' });
        }
        songId = Number(currentPlaying[0].song_id);
      }

      if (!(await validateSongBelongsToParty(songId, partyCode))) return;

      const songRows = await query(
        'SELECT status FROM songs WHERE song_id = ? AND party_code = ? LIMIT 1',
        [songId, partyCode]
      );
      if (!songRows.length) return;

      const songStatus = String(songRows[0].status || '').toLowerCase();

      // If host targets a queued song from the list, remove only that song from queue.
      if (songStatus === 'queued') {
        runTransactionSync([
          { sql: "UPDATE songs SET status='skipped' WHERE song_id=?", values: [songId] },
          { sql: 'DELETE FROM skip_votes WHERE song_id=?', values: [songId] },
        ]);
        await invalidateQueue(partyCode);
        await emitQueueUpdate(io, partyCode);
        qLog(
          `skipSong queued-remove party=${partyCode} hostUserId=${socket.user.userId} songId=${songId}`
        );
        return;
      }

      if (songStatus !== 'playing') {
        return socket.emit('actionError', { message: 'Song cannot be skipped in current state' });
      }

      await skipSongAndAdvance(io, partyCode, songId);
      qLog(`skipSong direct party=${partyCode} hostUserId=${socket.user.userId} songId=${songId}`);
    } catch (err) {
      Logger.error('queue', `skipSong error: ${err.message}`, err);
    }
  });

  /* ================= SKIP VOTE ================= */
  socket.on('skipVote', async ({ songId }) => {
    try {
      const partyCode = socket.user?.partyCode;
      const normalizedSongId = Number.parseInt(songId, 10);
      if (!partyCode || !Number.isInteger(normalizedSongId)) return;
      if (await checkRateLimit(socket, 'skip-vote', 12, 10)) return;
      if (!(await ensurePartyActive(partyCode))) return;
      if (!(await validateSongBelongsToParty(normalizedSongId, partyCode, 'playing'))) return;

      const voteData = await withPartyLock(partyCode, async () => {
        return runTransactionSync(() => {
          const existingVote = query(
            'SELECT 1 FROM skip_votes WHERE user_id = ? AND song_id = ? LIMIT 1',
            [socket.user.userId, normalizedSongId]
          );
          if (!existingVote.length) {
            query('INSERT INTO skip_votes (user_id, song_id) VALUES (?, ?)', [
              socket.user.userId,
              normalizedSongId,
            ]);
          }

          const [{ cnt }] = query('SELECT COUNT(*) AS cnt FROM skip_votes WHERE song_id=?', [
            normalizedSongId,
          ]);
          const currentCnt = Number(cnt) || 0;

          // For visual context, we still calculate the theoretical threshold based on online guests.
          const [{ gcnt }] = query(
            'SELECT COUNT(*) AS gcnt FROM users WHERE party_code = ? AND role = ? AND is_online = 1',
            [partyCode, 'guest']
          );
          const threshold = Math.floor((Number(gcnt) || 0) / 2) + 1;

          return { count: currentCnt, threshold };
        });
      });

      // We no longer auto-skip based on threshold. We only emit the skip vote count to the party
      // so the host can see it and decide whether to manually skip.
      io.to(partyCode).emit('skipVoteUpdate', {
        songId: normalizedSongId,
        count: voteData.count,
        needed: voteData.threshold,
      });

      qLog(
        `skipVote party=${partyCode} userId=${socket.user.userId} songId=${normalizedSongId} count=${voteData.count} needed=${voteData.threshold}`
      );
    } catch (err) {
      Logger.error('queue', `skipVote error: ${err.message}`, err);
    }
  });

  /* ================= REACTIONS ================= */
  socket.on('reactToSong', async ({ songId, emoji }) => {
    try {
      const partyCode = socket.user?.partyCode;
      const normalizedSongId = Number.parseInt(songId, 10);
      if (!partyCode || !Number.isInteger(normalizedSongId)) return;
      if (await checkRateLimit(socket, 'react-song', 25, 10)) return;
      if (!(await ensurePartyActive(partyCode))) return;
      if (!(await validateSongBelongsToParty(normalizedSongId, partyCode))) return;

      if (!['fire', 'clap', 'dance'].includes(emoji)) return;

      // Map emoji names to Unicode symbols for display
      const emojiMap = {
        fire: '🔥',
        clap: '👏',
        dance: '💃',
      };

      // Persist reaction to database
      await query('INSERT INTO reactions (user_id, song_id, emoji) VALUES (?, ?, ?)', [
        socket.user.userId,
        normalizedSongId,
        emojiMap[emoji] || emoji,
      ]);

      // Broadcast to all clients in party
      io.to(partyCode).emit('reactionUpdate', {
        emoji: emojiMap[emoji] || emoji,
        from: socket.user.username,
        at: Date.now(),
      });
      qLog(
        `reaction party=${partyCode} userId=${socket.user.userId} songId=${normalizedSongId} emoji=${emoji}`
      );
    } catch (err) {
      Logger.error('queue', `reactToSong error: ${err.message}`, err);
    }
  });

  socket.on('syncNowPlaying', async () => {
    try {
      const partyCode = socket.user?.partyCode;
      if (!partyCode) return;
      await emitCurrentNowPlayingToSocket(socket, partyCode);
    } catch (err) {
      Logger.error('queue', `syncNowPlaying error: ${err.message}`, err);
    }
  });

  socket.on('reconnectHeartbeat', async () => {
    try {
      const partyCode = socket.user?.partyCode;
      const userId = socket.user?.userId;
      if (!partyCode || !userId) return;

      // Mark user back online and update socket_id in DB
      await query('UPDATE users SET is_online = 1, socket_id = ? WHERE user_id = ?', [
        socket.id,
        userId,
      ]);

      // Cancel any pending leader election for this party (originally in leaderElection.js)
      const {
        cancelElectionTimer,
        releaseElectionLock,
        cancelNoUsersEndTimer,
      } = require('./leaderElection');
      if (cancelElectionTimer) cancelElectionTimer(partyCode);
      if (releaseElectionLock) await releaseElectionLock(partyCode);
      if (cancelNoUsersEndTimer) cancelNoUsersEndTimer(partyCode);

      // Sync playback state and queue to the reconnecting client
      await emitCurrentNowPlayingToSocket(socket, partyCode);
      await emitQueueUpdateToSocket(socket, partyCode);

      qLog(`reconnectHeartbeat party=${partyCode} userId=${userId}`);
    } catch (err) {
      Logger.error('queue', `reconnectHeartbeat error: ${err.message}`, err);
    }
  });
};

module.exports.emitQueueUpdate = emitQueueUpdate;
module.exports.emitQueueUpdateToSocket = emitQueueUpdateToSocket;
module.exports.emitNowPlaying = emitNowPlaying;
module.exports.emitCurrentNowPlayingToSocket = emitCurrentNowPlayingToSocket;
module.exports.startNextSong = startNextSong;
module.exports.ensurePlaybackStarted = ensurePlaybackStarted;
module.exports.clearSafetyTimer = clearSafetyTimer;
