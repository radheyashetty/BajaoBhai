const { query } = require('../db');
const { redis, isRedisReady } = require('./redisClient');
const Logger = require('./logger');

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

async function clearRedisPartyState(partyCode) {
  if (!isRedisReady() || !partyCode) return;

  const code = String(partyCode).toUpperCase();
  try {
    const patterns = [`queue:${code}`, `nowPlaying:${code}`, `election:${code}`, `rl:*:${code}:*`];
    const keyBuckets = await Promise.all(patterns.map((pattern) => scanKeys(pattern)));
    const keys = [...new Set(keyBuckets.flat())];
    if (keys.length) {
      await redis.del(...keys);
    }
  } catch (err) {
    Logger.warn('cleanup', `clearRedisPartyState failed: ${err.message}`);
  }
}

async function endParty(io, partyCode, reason = 'party-ended') {
  if (!partyCode) return;

  const code = String(partyCode).toUpperCase();

  await query(
    "UPDATE parties SET status = 'ended', ended_at = datetime('now') WHERE party_code = ?",
    [code]
  );

  await clearRedisPartyState(code);

  const roomName = code;
  if (io) {
    io.to(roomName).emit('partyEnded', {
      message: 'Party has been ended by the host or admin.',
      reason,
    });

    const room = io.sockets.adapter.rooms.get(roomName);
    if (room) {
      room.forEach((socketId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) socket.disconnect(true);
      });
    }
  }
}

async function runGlobalZombieCleanup(io) {
  try {
    Logger.info('cleanup', 'Starting global zombie party audit...');

    // Find parties that are 'active' but have zero users with 'is_online = 1'
    const zombies = await query(`
      SELECT p.party_code 
      FROM parties p
      WHERE p.status = 'active'
      AND p.party_code NOT IN (
        SELECT DISTINCT party_code FROM users WHERE is_online = 1
      )
    `);

    if (zombies.length === 0) {
      Logger.info('cleanup', 'No zombie parties found.');
      return;
    }

    Logger.info('cleanup', `Found ${zombies.length} zombie parties. Starting cleanup...`);

    for (const row of zombies) {
      const partyCode = row.party_code;
      try {
        await endParty(io, partyCode, 'zombie-cleanup');
        Logger.info('cleanup', `Terminated zombie party: ${partyCode}`);
      } catch (err) {
        Logger.error('cleanup', `Failed to terminate party ${partyCode}: ${err.message}`, err);
      }
    }

    Logger.info('cleanup', 'Global zombie audit completed.');
  } catch (err) {
    Logger.error('cleanup', `Global audit error: ${err.message}`, err);
  }
}

module.exports = {
  endParty,
  clearRedisPartyState,
  runGlobalZombieCleanup,
};
