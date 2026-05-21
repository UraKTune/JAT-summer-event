const ENV = {
  BE_URL: 'https://jat-summer-backend.onrender.com', // URL Express backend trên Render
  // ── Server ───────────────────────────────────────────────────
  PORT: 3000,
  NODE_ENV: 'production',

// ── osu! OAuth ───────────────────────────────────────────────
  OSU_CLIENT_ID: '',
  OSU_CLIENT_SECRET: '',
  OSU_REDIRECT_URI: 'https://jat-summer-backend.onrender.com/callback',

// ── Google Apps Script ───────────────────────────────────────
  GAS_URL: 'https://script.google.com/macros/s/YOUR_ID/exec',
  GAS_SECRET: 'random-secret-string-shared-with-GAS',

// ── URLs ─────────────────────────────────────────────────────
  FRONTEND_URL: 'https://UraKTune.github.io/jat-summer-event',

// ── Session ──────────────────────────────────────────────────
  SESSION_SECRET: 'another-random-long-string',

// ── Beatmap IDs (difficulty ID, sau #osu/ trong URL) ─────────
  BEATMAP_ID_0: '',
  BEATMAP_ID_1: '',
  BEATMAP_ID_2: '',
  BEATMAP_ID_3: '',
  BEATMAP_ID_4: ''

};
