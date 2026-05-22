// ============================================================
// app.js — Frontend gọi BE (Express) thay vì GAS trực tiếp
//
// BE_URL đặt trong env.js — không có secret nào ở đây.
// Session quản lý bởi BE (httpOnly cookie) — an toàn hơn localStorage token.
//
// Sau khi login:
//   BE redirect về FRONTEND?auth=success&uid=&name=&avatar=
//   app.js lưu uid/name/avatar vào localStorage (public info, không nhạy cảm)
//   Session thật nằm trong cookie httpOnly của BE
// ============================================================

const BE = ENV.BE_URL.replace(/\/$/, ''); // Base URL của Express backend

// ── localStorage keys (chỉ lưu thông tin public) ─────────────
const LS = {
  UID:          'osu_uid',
  NAME:         'osu_name',
  AVATAR:       'osu_avatar',
  TOKEN:        'osu_token',
  LB_CACHE:     'lb_cache',
  LB_TIMESTAMP: 'lb_last_changed',
};

// ============================================================
// AUTH
// ============================================================

function saveUser(uid, name, avatar, token='') {
  localStorage.setItem(LS.UID,    String(uid));
  localStorage.setItem(LS.NAME,   name);
  localStorage.setItem(LS.AVATAR, avatar);
  if (token) localStorage.setItem(LS.TOKEN, token);
}

function getUser() {
  const uid = localStorage.getItem(LS.UID);
  if (!uid) return null;
  return {
    uid,
    name:   localStorage.getItem(LS.NAME)   || '',
    avatar: localStorage.getItem(LS.AVATAR) || '',
  };
}

function logout() {
  Object.values(LS).forEach(k => localStorage.removeItem(k));
  fetch(BE + '/auth/logout', { method: 'POST' })
    .finally(() => { window.location.href = 'index.html'; });
}

// Redirect đến BE để bắt đầu OAuth
function loginWithOsu() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  window.location.href = BE + '/auth/login?from=' + encodeURIComponent(page);
}

// Đọc query params sau khi BE redirect về
function checkAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const auth   = params.get('auth');
  if (!auth) return;

  if (auth === 'success') {
    const uid    = params.get('uid')    || '';
    const name   = params.get('name')   || '';
    const avatar = params.get('avatar') || '';
    const token = params.get('token') || '';
    if (uid) {
      saveUser(uid, name, avatar, token);
      showToast('✓ Xin chào ' + name + '!', 'success');
    }
  } else if (auth === 'error') {
    showToast('Đăng nhập thất bại: ' + (params.get('msg') || ''), 'error');
  }

  history.replaceState({}, '', window.location.pathname);
}

// Kiểm tra token với BE
async function checkSession() {
  try {
    const token = getToken();
    if (!token) return false;
    const res = await fetch(BE + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ok === true;
  } catch (e) { return false; }
}

// Guard: xác minh session trước khi action quan trọng
async function requireAuth() {
  const user = getUser();
  if (!user) {
    showToast('Bạn cần đăng nhập!', 'error');
    setTimeout(loginWithOsu, 1500);
    return false;
  }
  // Verify với BE (1 request nhẹ)
  const valid = await checkSession();
  if (!valid) {
    showToast('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.', 'error');
    setTimeout(loginWithOsu, 1500);
    return false;
  }
  return true;
}

// ============================================================
// API HELPERS — gọi BE (Express)
// ============================================================

function getToken() {
  return localStorage.getItem(LS.TOKEN) || '';
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token
    ? { 'Authorization': 'Bearer ' + token, ...extra }
    : { ...extra };
}

async function apiGet(path, params = {}) {
  const qs  = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  try {
    const res  = await fetch(BE + path + qs, { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    console.error('apiGet error:', path, e);
    return null;
  }
}

async function apiPost(path, body = {}) {
  try {
    const res = await fetch(BE + path, {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data?.code === 'AUTH_REQUIRED') {
      showToast('Phiên đăng nhập hết hạn.', 'error');
      setTimeout(loginWithOsu, 1500);
    }
    return data;
  } catch (e) {
    console.error('apiPost error:', path, e);
    return null;
  }
}

// Lấy dữ liệu player (quiz + scores)
async function fetchPlayerData(uid) {
  return apiGet(`/api/player/${uid}`);
}

// Submit score — BE tự lấy plays từ osu! API
async function submitScore(challengeIndex) {
  if (!(await requireAuth())) return null;
  return apiPost('/api/score/submit', { challengeIndex });
}

// ============================================================
// LEADERBOARD — chỉ fetch khi có thay đổi thật
// ============================================================

let _lbPolling = null;

async function _getLastChanged() {
  const res = await apiGet('/api/lastchanged');
  return res ? Number(res.lastChanged || 0) : 0;
}

async function _fetchAndCacheLb() {
  const res = await apiGet('/api/leaderboard/full');
  if (res?.ok) localStorage.setItem(LS.LB_CACHE, JSON.stringify(res));
  return res;
}

function getCachedLeaderboard() {
  try {
    const raw = localStorage.getItem(LS.LB_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function startLeaderboardPolling(onUpdate) {
  const cached = getCachedLeaderboard();
  if (cached) onUpdate(cached);

  async function checkAndUpdate() {
    if (document.hidden) return; // không poll khi tab bị ẩn

    const serverTs = await _getLastChanged();
    const clientTs = Number(localStorage.getItem(LS.LB_TIMESTAMP) || 0);
    if (serverTs > clientTs) {
      const fresh = await _fetchAndCacheLb();
      if (fresh) {
        localStorage.setItem(LS.LB_TIMESTAMP, String(serverTs));
        onUpdate(fresh);
      }
    }
  }

  await checkAndUpdate();
  if (_lbPolling) clearInterval(_lbPolling);
  _lbPolling = setInterval(checkAndUpdate, 30_000);
}

function stopLeaderboardPolling() {
  if (_lbPolling) { clearInterval(_lbPolling); _lbPolling = null; }
}

// ============================================================
// UI HELPERS
// ============================================================

function updateNavAuth() {
  const area = document.getElementById('nav-auth');
  if (!area) return;
  const user = getUser();
  if (user) {
    area.innerHTML = `
      <img src="${user.avatar}" alt="${user.name}" class="nav-avatar"
           onerror="this.src='https://osu.ppy.sh/assets/images/favicon-32x32.png'">
      <span class="nav-username">${user.name}</span>
      <button onclick="logout()" class="btn-logout">Đăng xuất</button>`;
  } else {
    area.innerHTML = `
      <button onclick="loginWithOsu()" class="btn-login">
        <img src="https://osu.ppy.sh/assets/images/favicon-32x32.png" width="16" height="16" alt="osu!">
        Đăng nhập osu!
      </button>`;
  }
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = 'show ' + (type || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3500);
}

function fmtScore(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('vi-VN');
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  checkAuthCallback();
  updateNavAuth();
});

window.addEventListener('beforeunload', stopLeaderboardPolling);
