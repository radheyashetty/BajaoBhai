require('dotenv').config();
const { query, runTransactionSync } = require('../server/db');
const { sign } = require('../server/utils/tokenUtils');

function seedDemo() {
  console.log('Seeding demo party DEMO99...');

  runTransactionSync([
    { sql: 'DELETE FROM chat_messages WHERE party_code = ?', values: ['DEMO99'] },
    { sql: 'DELETE FROM votes WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)', values: ['DEMO99'] },
    { sql: 'DELETE FROM songs WHERE party_code = ?', values: ['DEMO99'] },
    { sql: 'DELETE FROM users WHERE party_code = ?', values: ['DEMO99'] },
    { sql: 'DELETE FROM parties WHERE party_code = ?', values: ['DEMO99'] }
  ]);

  // Insert party first
  query(
    'INSERT INTO parties (party_code, party_name, status, is_public) VALUES (?, ?, ?, ?)',
    ['DEMO99', 'Bajao Bhai Chill Lounge 🎧', 'active', 1]
  );

  // Insert host user
  const hostUserRes = query(
    'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
    ['DJ Radheya', 'DEMO99', 'host', 1, '#8b5cf6']
  );
  const hostId = hostUserRes.insertId;

  // Set host_user_id on party
  query('UPDATE parties SET host_user_id = ? WHERE party_code = ?', [hostId, 'DEMO99']);

  // Insert guests
  const priyaRes = query(
    'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
    ['Priya', 'DEMO99', 'guest', 1, '#ec4899']
  );
  const priyaId = priyaRes.insertId;

  const amanRes = query(
    'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
    ['Aman', 'DEMO99', 'guest', 1, '#10b981']
  );
  const amanId = amanRes.insertId;

  const nehaRes = query(
    'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
    ['Neha', 'DEMO99', 'guest', 1, '#f59e0b']
  );
  const nehaId = nehaRes.insertId;

  // Insert songs
  // 1. Playing
  query(
    'INSERT INTO songs (party_code, video_id, title, channel_name, thumbnail, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'DEMO99',
      '34Na4j8AVgA',
      'Starboy - The Weeknd ft. Daft Punk',
      'The Weeknd',
      'https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg',
      230,
      hostId,
      'playing'
    ]
  );

  // 2. Queued 1
  const song2Res = query(
    'INSERT INTO songs (party_code, video_id, title, channel_name, thumbnail, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'DEMO99',
      '4NRXx6U8ABQ',
      'Blinding Lights - The Weeknd',
      'The Weeknd',
      'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg',
      200,
      priyaId,
      'queued'
    ]
  );
  const s2Id = song2Res.insertId;

  // 3. Queued 2
  const song3Res = query(
    'INSERT INTO songs (party_code, video_id, title, channel_name, thumbnail, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'DEMO99',
      'TUVcZfQe-Kw',
      'Levitating - Dua Lipa',
      'Dua Lipa',
      'https://i.ytimg.com/vi/TUVcZfQe-Kw/hqdefault.jpg',
      203,
      amanId,
      'queued'
    ]
  );
  const s3Id = song3Res.insertId;

  // 4. Queued 3
  const song4Res = query(
    'INSERT INTO songs (party_code, video_id, title, channel_name, thumbnail, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'DEMO99',
      'BddP6PYo2gs',
      'Kesariya - Brahmāstra | Arijit Singh',
      'Sony Music India',
      'https://i.ytimg.com/vi/BddP6PYo2gs/hqdefault.jpg',
      268,
      nehaId,
      'queued'
    ]
  );
  const s4Id = song4Res.insertId;

  // Insert votes
  if (s2Id) {
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [hostId, s2Id, 'up']);
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [priyaId, s2Id, 'up']);
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [amanId, s2Id, 'up']);
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [nehaId, s2Id, 'up']);
  }
  if (s3Id) {
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [priyaId, s3Id, 'up']);
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [amanId, s3Id, 'up']);
  }
  if (s4Id) {
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [nehaId, s4Id, 'up']);
  }

  // Insert chat messages
  query('INSERT INTO chat_messages (party_code, user_id, message) VALUES (?, ?, ?)', [
    'DEMO99',
    hostId,
    'Welcome to the Bajao Bhai lounge! Drop your favorite tracks and vote 🙌'
  ]);
  query('INSERT INTO chat_messages (party_code, user_id, message) VALUES (?, ?, ?)', [
    'DEMO99',
    priyaId,
    'Hey everyone! That Weeknd transition was clean 🔥'
  ]);
  query('INSERT INTO chat_messages (party_code, user_id, message) VALUES (?, ?, ?)', [
    'DEMO99',
    amanId,
    'Just upvoted Levitating, let’s get that played next!'
  ]);
  query('INSERT INTO chat_messages (party_code, user_id, message) VALUES (?, ?, ?)', [
    'DEMO99',
    nehaId,
    'Banger queue tonight! 🎉'
  ]);

  // Generate tokens
  const hostToken = sign({
    userId: hostId,
    partyCode: 'DEMO99',
    role: 'host',
    username: 'DJ Radheya'
  });

  const sessionObj = {
    userId: hostId,
    partyCode: 'DEMO99',
    role: 'host',
    username: 'DJ Radheya',
    token: hostToken
  };

  console.log('Seed completed successfully!');
  console.log('Host session JSON:');
  console.log(JSON.stringify(sessionObj));
}

seedDemo();
