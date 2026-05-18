// ╔══════════════════════════════════════════════════════════════╗
// ║  server.js — CTA JAT Edition · Express Backend               ║
// ║                                                              ║
// ║  .env cần có:                                                ║
// ║    PORT              (mặc định 3000)                         ║
// ║    OSU_CLIENT_ID     osu! developer console                  ║
// ║    OSU_CLIENT_SECRET osu! developer console                  ║
// ║    OSU_REDIRECT_URI  https://YOUR.onrender.com/callback      ║
// ║    GAS_URL           GAS Web App URL (/exec)                 ║
// ║    GAS_SECRET        secret key BE ↔ GAS                     ║
// ║    FRONTEND_URL      GitHub Pages URL                        ║
// ║    SESSION_SECRET    chuỗi random dài                        ║
// ║    BEATMAP_ID_0..4   beatmap difficulty IDs                  ║
// ╚══════════════════════════════════════════════════════════════╝

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors    from 'cors';
import fetch   from 'node-fetch';

const app = express();

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   24 * 60 * 60 * 1000,
  },
}));

// ── Helpers ───────────────────────────────────────────────────

// Gọi GAS — BE là client duy nhất được phép gọi GAS
async function callGAS(params) {
  const qs = new URLSearchParams({ ...params, gas_secret: process.env.GAS_SECRET }).toString();
  const r  = await fetch(process.env.GAS_URL + '?' + qs);
  return r.json();
}

// osu! public token — cached memory, tự refresh khi hết hạn
let _tokCache = null;
async function getOsuToken() {
  if (_tokCache && Date.now() < _tokCache.exp) return _tokCache.token;
  const r = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.OSU_CLIENT_ID, client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: 'client_credentials', scope: 'public',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Cannot get osu! token');
  _tokCache = { token: d.access_token, exp: Date.now() + 23 * 60 * 60 * 1000 };
  return _tokCache.token;
}

// Guard — route cần đăng nhập
function auth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', msg: 'Chưa đăng nhập' });
  next();
}

// ── Challenge config (beatmapId chỉ tồn tại ở BE) ────────────
const CHALLENGES = [
  { id:0, beatmapId: process.env.BEATMAP_ID_0, sortOrder:'desc', scoreType:'score',      scoreLabel:'Tổng Score'    },
  { id:1, beatmapId: process.env.BEATMAP_ID_1, sortOrder:'asc',  scoreType:'miss_count', scoreLabel:'Số miss'       },
  { id:2, beatmapId: process.env.BEATMAP_ID_2, sortOrder:'desc', scoreType:'accuracy',   scoreLabel:'Accuracy (%)'  },
  { id:3, beatmapId: process.env.BEATMAP_ID_3, sortOrder:'desc', scoreType:'score',      scoreLabel:'Tổng Score'    },
  { id:4, beatmapId: process.env.BEATMAP_ID_4, sortOrder:'asc',  scoreType:'50s',        scoreLabel:'Số lượng 50'   },
];

function extractVal(play, scoreType) {
  switch (scoreType) {
    case 'score':      return play.score                              || 0;
    case 'accuracy':   return parseFloat((play.accuracy * 100).toFixed(2));
    case 'miss_count': return play.statistics?.countmiss              ?? 0;
    case '50s':        return play.statistics?.count50                ?? 0;
    default:           return play.score                              || 0;
  }
}

// ════════════════════════════════════════════════════════════
// AUTH — OAuth osu!
// Flow: frontend → GET /auth/login → osu! → GET /callback → frontend
// ════════════════════════════════════════════════════════════

// [1] Bắt đầu login
app.get('/auth/login', (req, res) => {
  const from = req.query.from || 'index.html';
  req.session.oauthFrom = from;
  const qs = new URLSearchParams({
    client_id: process.env.OSU_CLIENT_ID, redirect_uri: process.env.OSU_REDIRECT_URI,
    response_type: 'code', scope: 'identify public', state: from,
  }).toString();
  res.redirect('https://osu.ppy.sh/oauth/authorize?' + qs);
});

// [2] Callback từ osu!
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const from = state || req.session.oauthFrom || 'index.html';
  const base = process.env.FRONTEND_URL.replace(/\/$/, '');

  if (!code) return res.redirect(`${base}/${from}?auth=error&msg=Missing+code`);

  // Đổi code → token
  let tok;
  try {
    const r = await fetch('https://osu.ppy.sh/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.OSU_CLIENT_ID, client_secret: process.env.OSU_CLIENT_SECRET,
        code, grant_type: 'authorization_code', redirect_uri: process.env.OSU_REDIRECT_URI,
      }),
    });
    tok = await r.json();
  } catch (e) { return res.redirect(`${base}/${from}?auth=error&msg=Token+exchange+failed`); }

  if (!tok.access_token) return res.redirect(`${base}/${from}?auth=error&msg=No+access+token`);

  // Lấy thông tin user
  let user;
  try {
    const r = await fetch('https://osu.ppy.sh/api/v2/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    user = await r.json();
  } catch (e) { return res.redirect(`${base}/${from}?auth=error&msg=Failed+to+fetch+user`); }

  if (!user?.id) return res.redirect(`${base}/${from}?auth=error&msg=Invalid+user+data`);

  // Lưu session server-side
  req.session.user = { uid: String(user.id), name: user.username, avatar: user.avatar_url || '' };

  // Lưu player vào Sheet nếu chưa có
  await callGAS({ action: 'savePlayer', uid: user.id, name: user.username }).catch(() => {});

  // Redirect về frontend — chỉ gửi thông tin public
  const params = new URLSearchParams({ auth: 'success', uid: user.id, name: user.username, avatar: user.avatar_url || '' }).toString();
  res.redirect(`${base}/${from}?${params}`);
});

// [3] Đăng xuất
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// [4] Kiểm tra session
app.get('/auth/me', auth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

// ════════════════════════════════════════════════════════════
// LEADERBOARD
// ════════════════════════════════════════════════════════════

app.get('/api/leaderboard', async (req, res) => {
  try { res.json(await callGAS({ action: 'getLeaderboard' })); }
  catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi leaderboard' }); }
});

app.get('/api/leaderboard/full', async (req, res) => {
  try { res.json(await callGAS({ action: 'getLeaderboardFull' })); }
  catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi leaderboard full' }); }
});

// Scores từng player của từng challenge — mini leaderboard trong competition.html
app.get('/api/leaderboard/challenges', async (req, res) => {
  try { res.json(await callGAS({ action: 'getChallengeScores' })); }
  catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi challenge scores' }); }
});

app.get('/api/lastchanged', async (req, res) => {
  try { res.json(await callGAS({ action: 'getLastChanged' })); }
  catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi' }); }
});

// ════════════════════════════════════════════════════════════
// PLAYER DATA
// ════════════════════════════════════════════════════════════

app.get('/api/player/:uid', async (req, res) => {
  try { res.json(await callGAS({ action: 'getPlayerData', uid: req.params.uid })); }
  catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi player data' }); }
});

// ════════════════════════════════════════════════════════════
// PUZZLE
// ════════════════════════════════════════════════════════════

app.post('/api/puzzle/mark', auth, async (req, res) => {
  const { puzzleIndex } = req.body;
  if (puzzleIndex === undefined) return res.status(400).json({ ok: false, msg: 'Missing puzzleIndex' });
  try {
    res.json(await callGAS({ action: 'markPuzzle', uid: req.session.user.uid, puzzleIndex }));
  } catch (e) { res.status(500).json({ ok: false, msg: 'Lỗi mark puzzle' }); }
});

// ════════════════════════════════════════════════════════════
// SUBMIT SCORE
// Flow: nhấn Submit → BE lấy 5 plays → lọc beatmap → best play → ghi GAS
// ════════════════════════════════════════════════════════════

app.post('/api/score/submit', auth, async (req, res) => {
  const { challengeIndex } = req.body;
  const cfg = CHALLENGES[challengeIndex];
  if (!cfg)           return res.status(400).json({ ok: false, msg: 'Challenge không tồn tại' });
  if (!cfg.beatmapId) return res.status(500).json({ ok: false, msg: `BEATMAP_ID_${challengeIndex} chưa set trong .env` });

  const uid = req.session.user.uid;

  let token;
  try { token = await getOsuToken(); }
  catch (e) { return res.status(500).json({ ok: false, msg: 'Không lấy được osu! token' }); }

  let plays;
  try {
    const r = await fetch(
      `https://osu.ppy.sh/api/v2/users/${uid}/scores/recent?limit=5&include_fails=0&mode=osu&legacy_only=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return res.status(500).json({ ok: false, msg: `osu! API lỗi ${r.status}` });
    plays = await r.json();
  } catch (e) { return res.status(500).json({ ok: false, msg: 'Lỗi kết nối osu! API' }); }

  if (!Array.isArray(plays) || plays.length === 0)
    return res.json({ ok: false, msg: 'Bạn chưa có play nào gần đây. Hãy chơi 1 lần rồi Submit!' });

  const mapPlays = plays.filter(p => String(p.beatmap?.id) === String(cfg.beatmapId));
  if (!mapPlays.length)
    return res.json({ ok: false, msg: 'Không tìm thấy play trên map này trong 5 lần gần nhất. Hãy chơi đúng map rồi Submit ngay!' });

  const best = [...mapPlays].sort((a, b) => {
    const va = extractVal(a, cfg.scoreType), vb = extractVal(b, cfg.scoreType);
    return cfg.sortOrder === 'asc' ? va - vb : vb - va;
  })[0];

  const scoreVal = extractVal(best, cfg.scoreType);

  let result;
  try {
    result = await callGAS({ action: 'writeScore', uid, challengeIndex, score: scoreVal });
  } catch (e) { return res.status(500).json({ ok: false, msg: 'Lỗi ghi score vào Sheet' }); }

  res.json({
    ...result,
    play: {
      score_val:   scoreVal,
      score_label: cfg.scoreLabel,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
