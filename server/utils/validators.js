/**
 * server/utils/validators.js
 * Input validation and sanitization helpers for Bajao Bhai
 */

// Video ID must start with an alphanumeric char (preventing flag injection e.g. --dump-json)
// and have length between 10 and 16 characters (standard YouTube video ID is 11 chars).
const YOUTUBE_VIDEO_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{9,15}$/;
const PARTY_CODE_REGEX = /^[A-Z0-9]{6}$/;

/**
 * Validates YouTube video ID format to prevent malformed queries or injection attacks.
 */
function isValidVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  return YOUTUBE_VIDEO_ID_REGEX.test(videoId.trim());
}

/**
 * Validates a normalized 6-character alphanumeric party code.
 */
function isValidPartyCode(partyCode) {
  if (!partyCode || typeof partyCode !== 'string') return false;
  return PARTY_CODE_REGEX.test(partyCode.trim().toUpperCase());
}

/**
 * Strips script tags (and content), HTML tags, and trims/slices a string to a safe maximum length.
 */
function sanitizeString(str, maxLength = 200) {
  if (str == null) return '';
  return String(str)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, maxLength);
}

module.exports = {
  isValidVideoId,
  isValidPartyCode,
  sanitizeString,
};
