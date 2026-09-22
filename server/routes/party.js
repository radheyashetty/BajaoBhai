const express = require('express');
const router = express.Router();
const { query, runTransactionSync } = require('../db');
const { generateUniquePartyCode } = require('../utils/codeGenerator');
const { sign } = require('../utils/tokenUtils');
const { isValidPartyCode, sanitizeString } = require('../utils/validators');
const Logger = require('../utils/logger');

const avatarColors = [
  '#ff6b6b',
  '#4ecdc4',
  '#45b7d1',
  '#96ceb4',
  '#ffeaa7',
  '#dda0dd',
  '#98d8c8',
  '#feca57',
  '#ff9ff3',
  '#f368e0',
  '#0abde3',
  '#10ac84',
  '#00d2d3',
  '#54a0ff',
  '#5f27cd',
  '#c8d6e5',
  '#ff9f43',
  '#ee5253',
  '#1dd1a1',
  '#ffc048',
  '#ef5777',
  '#575fcf',
  '#4bcffa',
  '#34e7e4',
  '#0be881',
];
const USERNAME_MAX_LEN = 20;

router.use((req, _res, next) => {
  Logger.info('route:party', `${req.method} ${req.originalUrl}`);
  next();
});

function pickAvatarColor() {
  return avatarColors[Math.floor(Math.random() * avatarColors.length)];
}

function normalizeUsername(username) {
  if (!username || typeof username !== 'string' || !username.trim()) {
    return null;
  }
  const clean = sanitizeString(username, USERNAME_MAX_LEN);
  if (!clean) return null;
  return clean;
}

function normalizePartyCode(rawCode) {
  return String(rawCode || '')
    .trim()
    .toUpperCase();
}

// join an existing party (guest)
router.post('/join', async (req, res) => {
  try {
    const { username, partyCode: rawCode } = req.body;

    const clean = normalizeUsername(username);
    if (!clean) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    if (String(username).trim().length > USERNAME_MAX_LEN) {
      return res
        .status(400)
        .json({ error: `Username too long (max ${USERNAME_MAX_LEN} characters)` });
    }

    const partyCode = normalizePartyCode(rawCode);
    if (!isValidPartyCode(partyCode)) {
      return res.status(400).json({ error: 'Invalid party code (must be 6 alphanumeric characters)' });
    }

    const randomColor = pickAvatarColor();

    const result = await runTransactionSync(() => {
      const parties = query('SELECT party_code, status FROM parties WHERE party_code = ? LIMIT 1', [
        partyCode,
      ]);
      if (!parties.length || parties[0].status !== 'active') {
        return { error: 'not_found' };
      }

      const userResult = query(
        'INSERT INTO users (username, party_code, role, avatar_color) VALUES (?, ?, ?, ?)',
        [clean, partyCode, 'guest', randomColor]
      );
      return { success: true, userId: userResult.insertId };
    });

    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Party not found or has ended' });
    }

    const token = sign({ userId: result.userId, partyCode, role: 'guest', username: clean });
    Logger.info(
      'party',
      `user joined role=guest userId=${result.userId} username=${clean} party=${partyCode}`
    );
    return res.json({
      partyCode,
      userId: result.userId,
      token,
      username: clean,
      avatarColor: randomColor,
      role: 'guest',
    });
  } catch (err) {
    Logger.error('party', `Join party error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to join party' });
  }
});

// create a party (host)
router.post('/create', async (req, res) => {
  try {
    const { username, partyName, isPublic } = req.body;

    const clean = normalizeUsername(username);
    if (!clean) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    if (String(username).trim().length > USERNAME_MAX_LEN) {
      return res
        .status(400)
        .json({ error: `Username too long (max ${USERNAME_MAX_LEN} characters)` });
    }

    const validPartyName = partyName ? sanitizeString(partyName, 60) : null;
    const randomColor = pickAvatarColor();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const partyCode = await generateUniquePartyCode();

      try {
        const result = await runTransactionSync(() => {
          query(
            'INSERT INTO parties (party_code, status, party_name, is_public) VALUES (?, ?, ?, ?) ',
            [partyCode, 'active', validPartyName, isPublic ? 1 : 0]
          );

          const userResult = query(
            'INSERT INTO users (username, party_code, role, avatar_color) VALUES (?, ?, ?, ?)',
            [clean, partyCode, 'host', randomColor]
          );
          const userId = userResult.insertId;

          query('UPDATE parties SET host_user_id = ? WHERE party_code = ?', [userId, partyCode]);
          return { userId };
        });

        const token = sign({ userId: result.userId, partyCode, role: 'host', username: clean });
        Logger.info(
          'party',
          `party created role=host userId=${result.userId} username=${clean} party=${partyCode}`
        );
        return res.json({
          partyCode,
          userId: result.userId,
          token,
          username: clean,
          avatarColor: randomColor,
        });
      } catch (txErr) {
        const message = String(txErr?.message || '');
        const isCollision =
          message.includes('UNIQUE constraint failed: parties.party_code') ||
          message.includes('SQLITE_CONSTRAINT');

        if (isCollision && attempt < 4) {
          continue;
        }
        throw txErr;
      }
    }

    throw new Error('Failed to create unique party code');
  } catch (err) {
    Logger.error('party', `Create party error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to create party' });
  }
});

// list public parties
router.get('/public', async (req, res) => {
  try {
    const parties = await query(`
            SELECT p.party_code, p.party_name, COUNT(u.user_id) AS user_count
            FROM parties p
            LEFT JOIN users u ON u.party_code = p.party_code AND u.is_online = 1
            WHERE p.status = 'active' AND p.is_public = 1
            GROUP BY p.party_code
            ORDER BY user_count DESC, p.created_at DESC
            LIMIT 20
        `);
    res.json({ parties });
  } catch (err) {
    Logger.error('party', `Public listing error: ${err.message}`, err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
