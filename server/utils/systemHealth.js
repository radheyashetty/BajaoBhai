/**
 * systemHealth.js — Centralized System Health & Alert Tracker
 *
 * Records and exposes alerts for:
 *  - YouTube API quota exceeded / key failures
 *  - Stream mode (yt-dlp) failures
 *  - General system-level issues
 *
 * Alerts are kept in-memory with a rolling window (max 200).
 * Admin can query GET /api/v1/admin/health to see active alerts.
 */

const Logger = require('./logger');

const MAX_ALERTS = 200;
const alerts = [];

// Counters for dashboard summary
const counters = {
  youtubeApiErrors: 0,
  youtubeQuotaExceeded: 0,
  streamFailures: 0,
  streamSuccesses: 0,
  searchSuccesses: 0,
  searchFailures: 0,
  lastYoutubeError: null,
  lastStreamError: null,
  startedAt: Date.now(),
};

/**
 * Push a new alert to the in-memory ring buffer.
 * @param {'youtube_api'|'stream'|'system'|'redis'|'db'} category
 * @param {'critical'|'warning'|'info'} severity
 * @param {string} message — short human-readable summary
 * @param {string} [detail] — optional longer detail (error stack, API response, etc.)
 */
function pushAlert(category, severity, message, detail = null) {
  const alert = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    category,
    severity,
    message,
    detail: detail ? String(detail).slice(0, 1000) : null,
  };

  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) {
    alerts.length = MAX_ALERTS;
  }

  // Always log alerts through the structured Logger
  const logMethod = severity === 'critical' ? 'error' : severity === 'warning' ? 'warn' : 'info';
  Logger[logMethod](
    'health',
    `[${category}] ${message}${detail ? ` | ${String(detail).slice(0, 200)}` : ''}`
  );
}

// ---- YouTube API Tracking ----

function recordYoutubeApiError(statusCode, reason, message) {
  counters.youtubeApiErrors++;
  counters.lastYoutubeError = new Date().toISOString();

  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
    counters.youtubeQuotaExceeded++;
    pushAlert(
      'youtube_api',
      'critical',
      `YouTube API quota EXCEEDED — searches will fail until quota resets (Pacific midnight)`,
      `HTTP ${statusCode} | reason=${reason} | ${message}`
    );
  } else if (reason === 'keyInvalid' || reason === 'accessNotConfigured') {
    pushAlert(
      'youtube_api',
      'critical',
      `YouTube API key is INVALID or not configured — all searches will fail`,
      `HTTP ${statusCode} | reason=${reason} | ${message}`
    );
  } else {
    pushAlert(
      'youtube_api',
      'warning',
      `YouTube API error: ${reason || 'unknown'}`,
      `HTTP ${statusCode} | ${message}`
    );
  }
}

function recordYoutubeApiSuccess() {
  counters.searchSuccesses++;
}

function recordSearchFailure(errorMessage) {
  counters.searchFailures++;
  pushAlert('youtube_api', 'warning', `YouTube search failed: ${errorMessage}`, errorMessage);
}

// ---- Stream Mode Tracking ----

function recordStreamFailure(videoId, errorMessage) {
  counters.streamFailures++;
  counters.lastStreamError = new Date().toISOString();

  // Classify the error
  let severity = 'warning';
  let summary = `Stream failed for video ${videoId}`;

  if (errorMessage.includes('HTTP Error 429') || errorMessage.includes('Too Many Requests')) {
    severity = 'critical';
    summary = `yt-dlp rate-limited by YouTube (HTTP 429) — stream mode may be temporarily unavailable`;
  } else if (errorMessage.includes('Sign in to confirm') || errorMessage.includes('bot')) {
    severity = 'critical';
    summary = `YouTube is blocking yt-dlp (bot detection) — stream mode will fail until cookies are refreshed`;
  } else if (errorMessage.includes('Video unavailable') || errorMessage.includes('Private video')) {
    severity = 'info';
    summary = `Video ${videoId} is unavailable or private`;
  } else if (errorMessage.includes('No direct playable')) {
    severity = 'warning';
    summary = `No playable audio format found for video ${videoId}`;
  } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
    severity = 'critical';
    summary = `Network connectivity issue — cannot reach YouTube servers`;
  }

  pushAlert('stream', severity, summary, `videoId=${videoId} | ${errorMessage}`);
}

function recordStreamSuccess() {
  counters.streamSuccesses++;
}

// ---- Getters for Admin API ----

function getAlerts(limit = 50, category = null) {
  let filtered = alerts;
  if (category) {
    filtered = alerts.filter((a) => a.category === category);
  }
  return filtered.slice(0, limit);
}

function getHealthSummary() {
  const now = Date.now();
  const uptimeMs = now - counters.startedAt;
  const uptimeHours = (uptimeMs / 3600000).toFixed(1);

  // Count recent critical alerts (last 1 hour)
  const oneHourAgo = new Date(now - 3600000).toISOString();
  const recentCritical = alerts.filter(
    (a) => a.severity === 'critical' && a.timestamp > oneHourAgo
  ).length;
  const recentWarnings = alerts.filter(
    (a) => a.severity === 'warning' && a.timestamp > oneHourAgo
  ).length;

  // Determine overall status
  let status = 'healthy';
  let statusMessage = 'All systems operational';
  if (recentCritical > 0) {
    status = 'critical';
    statusMessage = `${recentCritical} critical alert(s) in the last hour`;
  } else if (recentWarnings > 3) {
    status = 'degraded';
    statusMessage = `${recentWarnings} warnings in the last hour`;
  }

  return {
    status,
    statusMessage,
    uptimeHours: Number(uptimeHours),
    counters: { ...counters, startedAt: undefined },
    recentCritical,
    recentWarnings,
    totalAlerts: alerts.length,
  };
}

function clearAlerts() {
  const count = alerts.length;
  alerts.length = 0;
  counters.youtubeApiErrors = 0;
  counters.youtubeQuotaExceeded = 0;
  counters.streamFailures = 0;
  counters.streamSuccesses = 0;
  counters.searchSuccesses = 0;
  counters.searchFailures = 0;
  counters.lastYoutubeError = null;
  counters.lastStreamError = null;
  Logger.info('health', `Cleared ${count} alerts and reset counters`);
  return count;
}

module.exports = {
  pushAlert,
  recordYoutubeApiError,
  recordYoutubeApiSuccess,
  recordSearchFailure,
  recordStreamFailure,
  recordStreamSuccess,
  getAlerts,
  getHealthSummary,
  clearAlerts,
};
