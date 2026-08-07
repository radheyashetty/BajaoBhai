const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { verifyToken } = require('../utils/tokenUtils');
const Logger = require('../utils/logger');

router.use((req, _res, next) => {
  Logger.info('route:user', `${req.method} ${req.originalUrl}`);
  next();
});

// update user profile — requires auth
router.put('/profile', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { favoriteGenre } = req.body;
    Logger.info(
      'route:user',
      `profile update userId=${userId} favoriteGenre=${favoriteGenre || ''}`
    );

    const safeGenre = favoriteGenre ? String(favoriteGenre).trim().slice(0, 50) : null;
    await query('UPDATE users SET favorite_genre = ? WHERE user_id = ?', [safeGenre, userId]);
    res.json({ success: true });
  } catch (err) {
    Logger.error('route:user', `Profile update error: ${err.message}`, err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
