# Introduction to Distributed Systems: Application in Bajao Bhai

This document maps the **Introduction to Distributed Systems** course policy and syllabus to the actual architectural implementation of the **Bajao Bhai** project. It outlines how theoretical concepts—such as synchronization, fault tolerance, communication, and naming—are practically applied in real-world code.

---

## Unit 1: Introduction to Distributed System

### 1. Definition and Design Goals 
Bajao Bhai is a real-time distributed collaborative music queue application. Its primary design goals reflect core distributed system tenets:
- **Resource Sharing**: Multiple users seamlessly share and control a centralized playlist queue and playback state.
- **Transparency**: Network boundaries and latency are hidden from the user through real-time sync engines. The end-user feels as if the music is playing locally, even though it is synchronized across multiple devices globally.

### 3. System Architectures
- **Client-Server & Hybrid Architecture**: Bajao Bhai employs a hybrid architecture. The browser clients connect to Centralized Express + Socket.IO servers. However, internally, it uses a Decentralized backend pattern where multiple Node.js server instances communicate their state over a distributed Redis cluster using Pub/Sub.

### 4 & 5. Servers - General Design Issues & Server Clusters
- **Managing Clusters**: To manage a multi-node cluster, Bajao Bhai implements a **Node Registry**. 
  - *Location*: `server/utils/nodeRegistry.js`
  - *How it works*: Every server node registers itself via a heartbeat in the Redis cluster (`node:NODE_ID`) every 10 seconds. This allows the system to detect and manage active nodes dynamically.

---

## Unit 2: Communication

### 6 & 8. RPC (Remote Procedure Call) and RMI
- While Bajao Bhai utilizes REST APIs for initial handshake and file serving (`server/routes/party.js`), the primary RPC equivalent is driven by **Socket.IO event acknowledgments**. Clients dispatch remote procedures (e.g., `addSong`, `voteSong`) to the server, and the server executes them atomically.

### 9. Message Oriented Communication (Transient)
- *Location*: `server/sockets/queueHandler.js` and `server/sockets/chatHandler.js`
- **Implementation**: The application uses **transient message-oriented communication** via WebSockets (Socket.IO). Events like `sendChatMessage` and `voteSong` are transient messages sent strictly when the client and server application are running. 

### 10 & 11. Stream Oriented Communication & QoS
- *Location*: `server/routes/stream.js` 
- **Implementation**: Bajao Bhai implements true continuous media streaming (Stream Playback Mode). When a user’s network blocks native YouTube IFrames, the server utilizes `yt-dlp` to extract the direct audio CDN URL. It then acts as a streaming proxy utilizing `Transfer-Encoding: chunked` headers to pipe the binary audio buffer continuously to the client, effectively handling QoS and stream synchronization parameters.

---

## Unit 3: Synchronization

### 12. Physical Clock Synchronization & Drift Algorithms
- *Location*: `client/modules/player.js` (Lines 83-142)
- **Algorithm Used: 3-Tier Drift Correction Algorithm**
  - **How it works**: Network latency causes client playback to drift out of sync. To resolve this, Bajao Bhai acts as the centralized perfect clock. The server broadcasts a UNIX timestamp (`startedAt`). The client actively calculates `drift = ((Date.now() - startedAt) / 1000) - actualPosition`. 
  - **Correction Rules**: 
    1. If `|drift| > 6.0s` -> Native Hard Reset (re-buffer stream).
    2. If `|drift| > 2.5s` -> Hard Sync (force seek to exact time).
    3. If `|drift| > 0.4s` -> Micro-adjust (`playbackRate` adjusted slightly to 1.08x or 0.92x to catch up invisibly).
  - **Late Joiner Synchronization**: If a user joins mid-song, the server queries the Redis `nowPlaying` state, calculates exactly how far into the song the group is `(Date.now() - startedAt) / 1000`, and dispatches `resumeSeconds` specifically to the new client socket so they immediately sync up with the group's timeline.

### 15. Distributed Mutual Exclusion
- *Location*: `server/sockets/leaderElection.js` (Lines 24-39) and `server/sockets/queueHandler.js` (Lines 71-85)
- **Implementation**: When applying crucial state updates (e.g., electing a new host), Bajao Bhai runs a Mutual Exclusion lock. It executes a `SET NX PX 5000` command logic on the Redis cluster with the `election:PARTY_CODE` key. This acts as a Distributed Mutex, ensuring only ONE node processes the election event across the cluster. At the single-process level, it utilizes `withPartyLock` as a Promise-chain mutex to prevent localized race conditions during voting.

### 17. Traditional Election Algorithm
- *Location*: `server/sockets/leaderElection.js` (Lines 115-117)
- **Algorithm Used: Seniority-Based Leader Election**
  - **How it works**: When the primary Host node drops off (network failure), the system must elect a new Host. Instead of a Bully algorithm based on process ID, Bajao Bhai relies on a deterministic Seniority Algorithm. It queries the database for the oldest joined online guest (`user_id` ASC). By sorting and electing the oldest guest, all distributed nodes deterministically resolve the new Host without needing complex multi-round voting mechanisms.

### Distributed Consensus (Skip Voting Algorithm)
- *Location*: `server/sockets/queueHandler.js` (Lines 697-764)
- **Algorithm Used: Dynamic Majority Consensus**
  - **How it works**: Since the host doesn't dictate all actions, guests can vote to skip the current song. The threshold for skipping dynamically adjusts based on the live number of connected users. The system queries the DB for `is_online` status and requires `floor(onlineGuests / 2) + 1` votes to reach majority consensus. By continuously recalculating this threshold as users join/leave, the consensus algorithm safely resolves without deadlock.

---

## Unit 4: Fault Tolerance

### 19 & 23. Failure Models & Failure Detection
- *Location*: `server/sockets/leaderElection.js` (Lines 88-102) & `server/utils/partyCleanup.js`
- **Implementation**: The system detects user failure via heartbeat timeouts on WebSockets. If a Host disconnects, the failure is detected immediately (`socket.on('disconnect')`). It applies a **15-second Failure Grace Period** to tolerate temporary network drops before initiating Host Election. 

### 20 & 22. Failure Masking by Redundancy and Replication
- *Location*: `server/utils/redisClient.js` (Lines 47-49)
- **Implementation**: Total State Redundancy. The active queue and play states are written to SQLite (Disk) AND cached in a distributed Redis Instance. If the Redis cluster crashes (Failure), the `isRedisReady()` heartbeat flag fails, automatically masking the failure by gracefully routing all read/write paths back to local Node.JS memory (`fallbackNowPlaying` mapping) and the SQLite persistent disk without dropping client connections. 

### Extra Safety Feature: The Server Safety Timer
- *Location*: `server/sockets/queueHandler.js` (Lines 47-69)
- **Implementation**: If a Host's browser freezes (Byzantine fault/Process hang), it misses the `songEnded` signal. Masking this failure, the server sets a backend setTimeout safety trigger. If the Host doesn't advance the track, the Server forces it to advance mathematically.

---

## Unit 5: Naming

### 28 & 29. Names, Identifiers, Addresses & Flat Naming
- *Location*: `server/utils/codeGenerator.js`
- **Implementation**: The application uses a Flat Naming mechanism. A randomly generated 6-character identifier (e.g., `A7B9X2`) operates as the Party Code. This simple identifier resolves the users to a specific distributed room without revealing underlying database ID sequences or specific server IPv4 endpoints.
  - **Collision-Safe Algorithm**: A 6-character namespace creates a risk of collisions. The `codeGenerator` interacts with a DB `UNIQUE` constraint within a `while` loop (max 10 retries). If two nodes generate the same code simultaneously, the SQLite transaction rejects one, forcing it to instantly regenerate a new code, preventing cluster-wide namespace collisions.

### 24 & 26. Reliable Group Communication & Atomic Multicast
- *Location*: `server/sockets/queueHandler.js` and `server/sockets/userListBroadcast.js`
- **Implementation**: Built upon `Socket.IO` rooms. All connected WebSocket users are aggregated into a namespace group `socket.join(partyCode)`. Whenever a vote is cast or a song changes, an Atomic Multicast emits the updated serialized JSON queue state strictly to members of that specific subgroup.

---

## Summary of Extra System Features

Here are all the robust architectural choices extending beyond the standard syllabus:

1. **Dual Playback Engines**: Capable of switching between YouTube API (`iframe`) processing and raw server-proxied streaming (`yt-dlp`). (See `server/routes/stream.js`).
2. **Distributed Rate Limiting**: Built utilizing Lua Scripts in Redis, capping APIs natively per IP/User to prevent DDoS. (See `server/utils/rateLimiter.js`).
3. **Database Transaction Isolation**: Writing votes and song modifications guarantees ACID properties by wrapping statements in a single atomic Write-Ahead Logging (WAL) synchronous SQLite transaction. (See `server/db.js`).
4. **Garbage Collection (Zombie Cleanup Algorithm)**: Every 10 minutes, `server/utils/partyCleanup.js` initiates a recursive task assessing the active connections. Any DB instance marked active containing zero online connected sockets gets formally terminated, clearing system memory.
5. **In-Memory LRU API Caching**: YouTube API requests are extremely expensive (100-unit quota cost). To prevent immediate quota exhaustion across a distributed user-base, a time-to-live (TTL) 15-minute LRU cache maps previous string searches directly into Node memory. (See `server/routes/search.js`).
6. **Real-time Emoji & Chat System**: An internal XSS-sanitized chat engine (`server/sockets/chatHandler.js`) enables ephemeral group communication alongside the primary playback protocol, proving robust concurrent data streams over the same WebSocket namespaces.
7. **Playlist History Export**: REST API endpoints allowing users to export their distributed session's queue history as a JSON object after the party ends.
