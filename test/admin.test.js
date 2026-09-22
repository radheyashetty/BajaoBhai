const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const {
  recordYoutubeApiError,
  recordYoutubeApiSuccess,
  recordStreamFailure,
  recordStreamSuccess,
  getHealthSummary,
  getAlerts,
  clearAlerts,
} = require('../server/utils/systemHealth');

test('Admin & System Health Tracker', async (t) => {
  await t.test('tracks health status and alerts', () => {
    clearAlerts();

    let summary = getHealthSummary();
    assert.equal(summary.status, 'healthy');
    assert.equal(summary.totalAlerts, 0);

    // Record an error
    recordYoutubeApiError(403, 'quotaExceeded', 'The request cannot be completed because quota is exceeded.');
    summary = getHealthSummary();
    assert.equal(summary.status, 'critical');
    assert.equal(summary.totalAlerts, 1);

    const alerts = getAlerts(10);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].category, 'youtube_api');
    assert.equal(alerts[0].severity, 'critical');

    // Clear alerts
    const cleared = clearAlerts();
    assert.equal(cleared, 1);

    summary = getHealthSummary();
    assert.equal(summary.status, 'healthy');
    assert.equal(summary.totalAlerts, 0);
  });
});
