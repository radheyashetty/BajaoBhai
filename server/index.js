// server/index.js
const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();
const Logger = require('./utils/logger');
const { NODE_ID, startNodeHeartbeat, deregisterNode } = require('./utils/nodeRegistry');

process.on('uncaughtException', (err) => {
  Logger.error('system', 'UNCAUGHT EXCEPTION', err);
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  Logger.error(
    'system',
    'UNHANDLED REJECTION',
    reason instanceof Error ? reason : new Error(String(reason))
  );
});

const app = express();
const server = http.createServer(app);
const VERBOSE_HTTP_LOGS = process.env.BB_VERBOSE_HTTP_LOGS !== '0';

app.set('trust proxy', Number(process.env.BB_TRUST_PROXY_HOPS || 1));

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return '';
  const keys = Object.keys(body);
  return keys.length ? ` bodyKeys=${keys.slice(0, 10).join(',')}` : '';
}

// Security: Helmet for production headers, CSP disabled to allow YouTube/CDN embeds
const helmet = require('helmet');
app.use(
  helmet({
    contentSecurityPolicy: false, // YouTube IFrame API, Google Fonts, Bootstrap CDN need full CSP audit
    crossOriginEmbedderPolicy: false, // Required for YouTube IFrame embeds
  })
);
app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

const clientPath = path.join(__dirname, '../client');
app.use(express.static(clientPath));

const dataPath = path.join(__dirname, '../data');
app.use('/data', express.static(dataPath));

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Served-By', NODE_ID);
  next();
});

app.use((req, res, next) => {
  if (!VERBOSE_HTTP_LOGS) return next();
  const startedAt = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  Logger.info(
    'http',
    `-> ${req.method} ${req.originalUrl || req.url} ip=${ip}${summarizeBody(req.body)}`
  );
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    Logger.info(
      'http',
      `<- ${req.method} ${req.originalUrl || req.url} status=${res.statusCode} ${ms}ms`
    );
  });
  next();
});

// Routes
const partyRoutes = require('./routes/party');
const searchRoutes = require('./routes/search');
const queueRoutes = require('./routes/queue');
const voteRoutes = require('./routes/vote');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const streamRoutes = require('./routes/stream');

app.use('/api/v1/party', partyRoutes);
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/queue', queueRoutes);
app.use('/api/v1/vote', voteRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/stream', streamRoutes);

app.get('/api/v1/ping', (req, res) => res.json({ pong: true }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  Logger.error('express', `Unhandled route error: ${err.message}`, err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

async function start() {
  try {
    const missingEnvs = ['TOKEN_SECRET', 'ADMIN_SECRET'].filter((key) => !process.env[key]);
    if (missingEnvs.length > 0) {
      Logger.error(
        'startup',
        `Missing REQUIRED env variables: ${missingEnvs.join(', ')} — server cannot start`
      );
      process.exit(1);
    }

    if (!process.env.YOUTUBE_API_KEY) {
      Logger.warn('startup', 'YOUTUBE_API_KEY is not set — YouTube search will not work');
    }

    const { query, initSchema } = require('./db');
    const initSocket = require('./sockets');
    const { connectRedis } = require('./utils/redisClient');

    // 1. Connect Redis first (required for adapter)
    await connectRedis();

    // 2. Initialize Sockets exactly ONCE
    const io = initSocket(server);
    app.set('io', io);

    // 3. Database verification and schema
    query('SELECT 1');
    await initSchema();

    // 4. Cleanup tasks
    const { runGlobalZombieCleanup } = require('./utils/partyCleanup');
    runGlobalZombieCleanup(io);
    setInterval(() => runGlobalZombieCleanup(io), 10 * 60 * 1000);

    const heartbeatTimer = startNodeHeartbeat();

    const shutdown = async (signal) => {
      Logger.info('system', `Received ${signal}; shutting down node ${NODE_ID}`);
      clearInterval(heartbeatTimer);
      await deregisterNode();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    const PORT = Number(process.env.PORT) || 3002;

    app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

    server.listen(PORT, () => {
      Logger.info('system', `Bajao Bhai is live on port ${PORT}! node=${NODE_ID}`);
      Logger.info('system', `Open http://localhost:${PORT} in your browser`);
    });
  } catch (err) {
    Logger.error('system', `CRITICAL: Unable to start server: ${err.message}`, err);
    process.exit(1);
  }
}

start();
