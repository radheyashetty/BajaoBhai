const crypto = require('crypto');
const { query } = require('../db');

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function getSecret() {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) {
    throw new Error('TOKEN_SECRET is required');
  }
  return secret;
}

function sign(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Token payload must be an object');
  }

  const secret = getSecret();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bodyPayload = {
    ...payload,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(bodyPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function parseJsonBase64url(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function hasValidClaims(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!Number.isInteger(parsed.exp)) return false;
  if (!Number.isInteger(parsed.iat)) return false;
  if (!Number.isInteger(parsed.userId)) return false;
  if (typeof parsed.partyCode !== 'string' || parsed.partyCode.length !== 6) return false;
  if (!['host', 'guest'].includes(parsed.role)) return false;
  if (typeof parsed.username !== 'string' || parsed.username.length < 1) return false;
  return true;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;

  try {
    const secret = getSecret();
    const parsedHeader = parseJsonBase64url(header);
    if (parsedHeader?.alg !== 'HS256' || parsedHeader?.typ !== 'JWT') {
      return null;
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64url');

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(sig);
    if (
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      return null;
    }

    const parsed = parseJsonBase64url(body);
    if (!hasValidClaims(parsed)) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= parsed.exp) {
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

async function verifyToken(req, res, next) {
  try {
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }

    const token = authHeader.slice(7).trim();
    const claims = verify(token);
    if (!claims) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const rows = await query(
      'SELECT party_code, status FROM parties WHERE party_code = ? LIMIT 1',
      [claims.partyCode]
    );
    if (!rows.length || rows[0].status !== 'active') {
      return res.status(403).json({ error: 'Party is not active' });
    }

    req.user = claims;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Token verification failed' });
  }
}

module.exports = { sign, verify, verifyToken };
