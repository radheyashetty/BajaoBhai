# Bajao Bhai

Real-time party music queue app with collaborative voting, live playback sync, and automatic host handover.

## Features

- Real-time queue updates with Socket.IO
- Party create/join flow with short party codes
- Host-only playback controls (play, pause, seek, skip)
- Upvote/downvote ranking with live reorder
- Skip-vote threshold flow
- YouTube search and add-to-queue
- Optional Redis support for distributed realtime state

## Tech Stack

- Node.js + Express
- Socket.IO
- SQLite (`better-sqlite3`)
- Optional Redis (`ioredis`, `@socket.io/redis-adapter`)
- Vanilla frontend (`client/`)

## Project Structure

```text
client/      Static frontend files
server/      API routes, socket handlers, utilities
db/          SQL schema
data/        Runtime SQLite files (ignored in Git)
```

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/bajao-bhai.git
cd bajao-bhai
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Update `.env` with at least:

- `TOKEN_SECRET`
- `ADMIN_SECRET`

Optional but recommended:

- `YOUTUBE_API_KEY` for richer search
- `REDIS_URL` for scaling and shared realtime state

### 3. Run the app

```bash
npm start
```

The app runs at `http://localhost:3002` by default.

## Scripts

- `npm start` - Start production server
- `npm run dev` - Start with nodemon
- `npm run lint` - Run ESLint
- `npm run format` - Run Prettier

## API Health Endpoints

- `GET /health`
- `GET /api/v1/ping`

## Deployment Notes

- Set `NODE_ENV=production`
- Provide strong values for `TOKEN_SECRET` and `ADMIN_SECRET`
- Configure `PORT` via environment
- Use Redis in multi-instance deployments

## Admin & Analytics

The admin panel and analytics endpoints (`/api/v1/admin/*`) are protected by an admin secret. To access these routes, you must:
1. Define `ADMIN_SECRET` in your `.env` file.
2. Provide this secret in the `Authorization` header as `Bearer <ADMIN_SECRET>` when making requests to admin endpoints.

## Database Migration

- Fresh setup uses `db/schema_v3.sql` automatically during startup.
- Existing databases are migrated safely at startup by `server/db.js`.
- Legacy song columns (`artist`, `duration`) are rebuilt into `channel_name` and `duration_seconds` when needed.
- New runtime-safe additions (for example `parties.is_public`, `parties.party_name`, `parties.ended_at`, and `audit_log`) are created if missing.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening pull requests.

## Security

If you discover a vulnerability, please follow [SECURITY.md](SECURITY.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
