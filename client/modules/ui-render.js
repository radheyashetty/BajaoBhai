import { state } from './state.js';
import { DOM } from './dom.js';
import { isHostUser } from './utils.js';

/* ================= RENDER ================= */
export function renderUsers() {
  if (!DOM.usersList) return;
  DOM.usersList.innerHTML = '';

  if (!state.users.length) {
    DOM.usersList.innerHTML = '<div class="text-muted small">No users in the room yet.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const user of state.users) {
    const badge = document.createElement('span');
    badge.className = 'badge bg-secondary me-2 mb-2';
    badge.textContent = `${user.username}${user.role === 'host' ? ' (host)' : ''}`;
    fragment.appendChild(badge);
  }

  DOM.usersList.appendChild(fragment);
}

export function renderQueue() {
  if (!DOM.queueList) return;
  DOM.queueList.innerHTML = '';

  const songs = state.queue || [];
  if (DOM.queueCount) {
    DOM.queueCount.textContent = String(songs.length);
  }
  if (DOM.queueLoading) {
    DOM.queueLoading.style.display = songs.length ? 'none' : 'block';
    DOM.queueLoading.textContent = songs.length ? 'Loading...' : 'No songs in the queue yet. Add one to start the party.';
  }

  if (!songs.length) {
    DOM.queueList.innerHTML = '<div class="empty-queue-state text-muted small p-2">The queue is empty right now.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const song of songs) {
    const row = document.createElement('div');
    row.className = 'queue-item d-flex align-items-center justify-content-between gap-2 p-2';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'd-flex align-items-center gap-2';
    infoDiv.style.minWidth = '0';
    infoDiv.style.flex = '1';

    const title = document.createElement('span');
    title.textContent = song.title || 'Untitled';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    infoDiv.appendChild(title);

    const score = Number(song.net_score) || 0;
    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'badge ms-1';
    scoreBadge.style.fontSize = '0.7rem';
    scoreBadge.style.minWidth = '28px';
    if (score > 0) {
      scoreBadge.className += ' bg-success';
      scoreBadge.textContent = `+${score}`;
    } else if (score < 0) {
      scoreBadge.className += ' bg-danger';
      scoreBadge.textContent = `${score}`;
    } else {
      scoreBadge.className += ' bg-secondary';
      scoreBadge.textContent = '0';
    }
    infoDiv.appendChild(scoreBadge);
    row.appendChild(infoDiv);

    const actions = document.createElement('div');
    actions.className = 'd-flex gap-1';

    // We use window.handleVote etc. because these are often attached to buttons dynamically
    // or called from the window scope for simplicity.
    actions.appendChild(createQueueActionButton('⬆', 'btn btn-sm btn-outline-light', () => window.handleVote(song.song_id, 'up')));
    actions.appendChild(createQueueActionButton('⬇', 'btn btn-sm btn-outline-light', () => window.handleVote(song.song_id, 'down')));
    actions.appendChild(createQueueActionButton('⏭', 'btn btn-sm btn-outline-warning', () => window.handleSkipVote(song.song_id)));
    if (isHostUser()) {
      actions.appendChild(createQueueActionButton('Skip', 'btn btn-sm btn-outline-danger', () => window.handleHostSkip(song.song_id)));
    }

    row.appendChild(actions);
    fragment.appendChild(row);
  }

  DOM.queueList.appendChild(fragment);
}

function createQueueActionButton(text, className, onClick) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

export function updatePlayIcon(isPlaying) {
  if (!DOM.playIcon) return;
  DOM.playIcon.className = isPlaying ? 'fa fa-pause' : 'fa fa-play';
}

export function updateMuteIcon(isMuted) {
  if (!DOM.muteIcon) return;
  DOM.muteIcon.className = isMuted ? 'fa fa-volume-mute' : 'fa fa-volume-high';
}

export function updateHostControlsVisibility() {
  const isHost = isHostUser();
  if (DOM.hostSkipBtn) DOM.hostSkipBtn.classList.toggle('d-none', !isHost);
  if (DOM.relinquishHostBtn) DOM.relinquishHostBtn.classList.toggle('d-none', !isHost);
}



export function updateConnectionStatus(connected) {
  if (!DOM.connectionStatus) return;
  DOM.connectionStatus.textContent = connected ? 'Connected' : 'Reconnecting...';
  DOM.connectionStatus.className = connected ? 'badge bg-success' : 'badge bg-warning text-dark';
}



export function renderChatMessage(data) {
  if (!DOM.chatMessages) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg mb-1';
  const resolvedMsgId = data.msg_id ?? data.msgId;
  msgEl.dataset.msgId = resolvedMsgId;
  
  let rawTime = data.sent_at ?? data.sentAt ?? Date.now();
  // Ensure SQLite timestamp format (e.g. "YYYY-MM-DD HH:MM:SS") is parsed as UTC properly
  if (typeof rawTime === 'string' && !rawTime.includes('T') && !rawTime.endsWith('Z')) {
    rawTime = rawTime.replace(' ', 'T') + 'Z';
  }
  const time = new Date(rawTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isHost = String(data.role).toLowerCase() === 'host';
  const avatarColor = data.avatar_color ?? data.avatarColor ?? '#fff';
  
  // Time stamp
  const timeSpan = document.createElement('span');
  timeSpan.className = 'text-muted small';
  timeSpan.textContent = `[${time}]`;
  msgEl.appendChild(timeSpan);
  msgEl.appendChild(document.createTextNode(' '));

  // Username (safe — textContent prevents XSS)
  const nameStrong = document.createElement('strong');
  nameStrong.style.color = avatarColor;
  nameStrong.textContent = `${data.username}${isHost ? ' (host)' : ''}:`;
  msgEl.appendChild(nameStrong);
  msgEl.appendChild(document.createTextNode(' '));

  // Message body (safe — textContent prevents XSS)
  const msgSpan = document.createElement('span');
  msgSpan.textContent = data.message;
  msgEl.appendChild(msgSpan);

  // Host delete button
  if (isHostUser()) {
    const delBtn = document.createElement('button');
    delBtn.className = 'chat-delete-btn';
    delBtn.addEventListener('click', () => window.deleteMessage(resolvedMsgId));
    const delIcon = document.createElement('i');
    delIcon.className = 'fa fa-times';
    delBtn.appendChild(delIcon);
    msgEl.appendChild(delBtn);
  }
  
  DOM.chatMessages.appendChild(msgEl);
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}


export function renderTypingIndicator(username) {
  if (!DOM.chatTyping) return;
  DOM.chatTyping.textContent = username ? `${username} is typing...` : '';
}
