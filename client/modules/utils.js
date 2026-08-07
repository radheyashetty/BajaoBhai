import { state } from './state.js';
import { DOM } from './dom.js';
import { TOAST_DURATION_MS } from './constants.js';

/* ================= UTIL ================= */
export function showToast(msg) {
  if (!DOM.toast || !DOM.toastMsg) return;

  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
  }

  DOM.toastMsg.textContent = msg;
  DOM.toast.style.opacity = '1';

  state.toastTimer = setTimeout(() => {
    DOM.toast.style.opacity = '0';
    state.toastTimer = null;
  }, TOAST_DURATION_MS);
}

export function getStoredSession() {
  try {
    // Check localStorage first (new), then sessionStorage (legacy migration)
    const stored = localStorage.getItem('bb_user') || sessionStorage.getItem('bb_user');
    if (stored) {
      // Migrate from sessionStorage to localStorage if needed
      if (!localStorage.getItem('bb_user') && sessionStorage.getItem('bb_user')) {
        localStorage.setItem('bb_user', stored);
        sessionStorage.removeItem('bb_user');
      }
      return JSON.parse(stored);
    }
    return {};
  } catch {
    return {};
  }
}

export function persistSession() {
  if (state.session) {
    localStorage.setItem('bb_user', JSON.stringify(state.session));
  }
}


export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${rs.toString().padStart(2, '0')}`;
}

export function isHostUser() {
  return String(state.session?.role).toLowerCase() === 'host';
}

export function clampNumber(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}
