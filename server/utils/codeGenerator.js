const { query } = require('../db');

// generate an uppercase alphanumeric string of length 6
function randomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function generateUniquePartyCode() {
  let attempts = 0;
  while (attempts < 10) {
    const code = randomCode();
    const rows = await query('SELECT 1 FROM parties WHERE party_code = ? LIMIT 1', [code]);
    if (rows.length === 0) {
      return code;
    }
    attempts++;
  }
  throw new Error('Failed to generate unique party code');
}

module.exports = {
  randomCode,
  generatePartyCode: randomCode,
  generateUniquePartyCode,
};
