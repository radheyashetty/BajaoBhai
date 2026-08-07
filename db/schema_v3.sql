PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS parties (
    party_id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_code TEXT UNIQUE NOT NULL,
    host_user_id INTEGER,
    party_name TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','ended','suspended')),
    is_public INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (host_user_id) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_parties_party_code ON parties(party_code);
CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(status);
CREATE INDEX IF NOT EXISTS idx_parties_is_public ON parties(is_public, status);

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    party_code TEXT NOT NULL,
    role TEXT DEFAULT 'guest' CHECK(role IN ('host','guest')),
    socket_id TEXT,
    is_online INTEGER DEFAULT 1,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    avatar_color TEXT DEFAULT '#6366f1',
    favorite_genre TEXT,
    FOREIGN KEY (party_code) REFERENCES parties(party_code) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_users_party_code ON users(party_code);
CREATE INDEX IF NOT EXISTS idx_users_socket_id ON users(socket_id);
CREATE INDEX IF NOT EXISTS idx_users_party_online ON users(party_code, is_online);
CREATE INDEX IF NOT EXISTS idx_users_party_role ON users(party_code, role);

CREATE TABLE IF NOT EXISTS songs (
    song_id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_code TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    channel_name TEXT,
    thumbnail TEXT,
    duration_seconds INTEGER DEFAULT 0,
    added_by INTEGER,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','playing','played','skipped')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(party_code, video_id, status),
    FOREIGN KEY (party_code) REFERENCES parties(party_code) ON DELETE CASCADE,
    FOREIGN KEY (added_by) REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_party_code ON songs(party_code);
CREATE INDEX IF NOT EXISTS idx_songs_status ON songs(status);
CREATE INDEX IF NOT EXISTS idx_songs_added_at ON songs(added_at);
CREATE INDEX IF NOT EXISTS idx_songs_party_status ON songs(party_code, status);

CREATE TABLE IF NOT EXISTS votes (
    vote_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    vote_type TEXT NOT NULL CHECK(vote_type IN ('up','down')),
    voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, song_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES songs(song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_votes_user_id ON votes(user_id);
CREATE INDEX IF NOT EXISTS idx_votes_song_id ON votes(song_id);

CREATE TABLE IF NOT EXISTS skip_votes (
    skip_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, song_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES songs(song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_skip_votes_song_id ON skip_votes(song_id);
CREATE INDEX IF NOT EXISTS idx_skip_votes_user_id ON skip_votes(user_id);

CREATE TABLE IF NOT EXISTS reactions (
    reaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    reacted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES songs(song_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reactions_song_id ON reactions(song_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user_id ON reactions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_code TEXT,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    node_id TEXT,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_party ON audit_log(party_code);
