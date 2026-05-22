// ╔══════════════════════════════════════════════════════════════╗
// ║  server.js — JAT Summer Event                                ║
// ║  .env: PORT, DATABASE_URL, OSU_CLIENT_ID, OSU_CLIENT_SECRET  ║
// ║         OSU_REDIRECT_URI, FRONTEND_URL, SESSION_SECRET       ║
// ║         BEATMAP_ID_0..4, ADMIN_UIDS (comma-separated osu IDs)║
// ╚══════════════════════════════════════════════════════════════╝

import 'dotenv/config';
import express   from 'express';

import cors      from 'cors';
import fetch     from 'node-fetch';

import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { pool, initDB, log } from './db.js';

const app       = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Admin UIDs ────────────────────────────────────────────────
const ADMIN_UIDS = new Set(
  (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
function isAdmin(uid) { return ADMIN_UIDS.has(String(uid)); }

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
const corsOrigin = process.env.FRONTEND_URL
  ? new URL(process.env.FRONTEND_URL).origin
  : '*';
app.use(cors({ origin: corsOrigin, credentials: true }));

const JWT_SECRET = process.env.SESSION_SECRET || 'change-me';

function signToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}

// ── Guards ────────────────────────────────────────────────────
function auth(req, res, next) {
  const user = verifyToken(req);
  if (!user) return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', msg: 'Chưa đăng nhập' });
  req.user = user;
  next();
}
function adminOnly(req, res, next) {
  const user = verifyToken(req);
  if (!user || !isAdmin(user.uid))
    return res.status(403).json({ ok: false, msg: 'Không có quyền' });
  req.user = user;
  next();
}

// ── osu! token cache ──────────────────────────────────────────
let _tokCache = null;
async function getOsuToken() {
  if (_tokCache && Date.now() < _tokCache.exp) return _tokCache.token;
  const r = await fetch('https://osu.ppy.sh/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.OSU_CLIENT_ID,
      client_secret: process.env.OSU_CLIENT_SECRET,
      grant_type: 'client_credentials', scope: 'public',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Cannot get osu! token');
  _tokCache = { token: d.access_token, exp: Date.now() + 23 * 60 * 60 * 1000 };
  return _tokCache.token;
}

// ── Competition config ────────────────────────────────────────
const CHALLENGES = [
  { id:0, beatmapId: process.env.BEATMAP_ID_0, sortOrder:'desc', scoreType:'score',      scoreLabel:'Tổng Score'   },
  { id:1, beatmapId: process.env.BEATMAP_ID_1, sortOrder:'asc',  scoreType:'miss_count', scoreLabel:'Số miss'      },
  { id:2, beatmapId: process.env.BEATMAP_ID_2, sortOrder:'desc', scoreType:'accuracy',   scoreLabel:'Accuracy (%)' },
  { id:3, beatmapId: process.env.BEATMAP_ID_3, sortOrder:'desc', scoreType:'score',      scoreLabel:'Tổng Score'   },
  { id:4, beatmapId: process.env.BEATMAP_ID_4, sortOrder:'asc',  scoreType:'50s',        scoreLabel:'Số lượng 50'  },
];

function extractVal(play, scoreType) {
  switch (scoreType) {
    case 'score':      return play.score || 0;
    case 'accuracy':   return parseFloat((play.accuracy * 100).toFixed(2));
    case 'miss_count': return play.statistics?.countmiss ?? 0;
    case '50s':        return play.statistics?.count50   ?? 0;
    default:           return play.score || 0;
  }
}

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════

app.get('/auth/login', (req, res) => {
  const from = req.query.from || 'index.html';
  req.query.from = from;
  const qs = new URLSearchParams({
    client_id: process.env.OSU_CLIENT_ID,
    redirect_uri: process.env.OSU_REDIRECT_URI,
    response_type: 'code', scope: 'identify public', state: from,
  }).toString();
  res.redirect('https://osu.ppy.sh/oauth/authorize?' + qs);
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const from = state || req.query.from || '';
  const base = process.env.FRONTEND_URL.replace(/\/$/, '');
  // Nếu from là index.html thì redirect về root, tránh /index.html not found
  const dest = (!from || from === 'index.html') ? base : `${base}/${from}`;
  if (!code) return res.redirect(`${dest}?auth=error&msg=Missing+code`);

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
  } catch(e) {
    await log('error', 'auth_callback', null, { msg: e.message });
    return res.redirect(`${dest}?auth=error&msg=Token+exchange+failed`);
  }

  if (!tok.access_token) {
    await log('error', 'auth_no_token', null, { response: tok });
    return res.redirect(`${dest}?auth=error&msg=No+access+token`);
  }

  let user;
  try {
    const r = await fetch('https://osu.ppy.sh/api/v2/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    user = await r.json();
  } catch(e) {
    return res.redirect(`${dest}?auth=error&msg=Failed+to+fetch+user`);
  }

  if (!user?.id) return res.redirect(`${dest}?auth=error&msg=Invalid+user+data`);

  const userData = { uid: String(user.id), name: user.username, avatar: user.avatar_url || '' };
  const token = signToken(userData);

  await pool.query(
    `INSERT INTO players (osu_id, name, avatar)
     VALUES ($1,$2,$3)
     ON CONFLICT (osu_id) DO UPDATE SET name=$2, avatar=$3`,
    [String(user.id), user.username, user.avatar_url || '']
  ).catch(() => {});

  await log('info', 'login', String(user.id), { name: user.username });

  const params = new URLSearchParams({
    auth: 'success', uid: user.id, name: user.username,
    avatar: user.avatar_url || '', token,
  }).toString();
  res.redirect(`${dest}?${params}`);
});

app.post('/auth/logout', (req, res) => {
  // JWT stateless — client xóa token khỏi localStorage
  res.json({ ok: true });
});

app.get('/auth/me', auth, (req, res) => {
  res.json({
    ok: true,
    user: req.user,
    isAdmin: isAdmin(req.user.uid),
  });
});

// ════════════════════════════════════════════════════════════
// LEADERBOARD
// ════════════════════════════════════════════════════════════

async function buildLeaderboard() {
  const { rows: players } = await pool.query(`SELECT osu_id, name FROM players`);
  if (!players.length) return [];

  const { rows: cntRows } = await pool.query(
    `SELECT puzzle_id, COUNT(*) as cnt FROM puzzle_completions GROUP BY puzzle_id`
  );
  const cntMap = {};
  cntRows.forEach(r => { cntMap[r.puzzle_id] = parseInt(r.cnt); });

  const { rows: compRows } = await pool.query(`SELECT osu_id, puzzle_id FROM puzzle_completions`);
  const playerPuzzles = {};
  compRows.forEach(r => {
    if (!playerPuzzles[r.osu_id]) playerPuzzles[r.osu_id] = [];
    playerPuzzles[r.osu_id].push(parseInt(r.puzzle_id));
  });

  const { rows: scoreRows } = await pool.query(`SELECT osu_id, challenge_id, score_val FROM challenge_scores`);
  const playerScores = {};
  scoreRows.forEach(r => {
    if (!playerScores[r.osu_id]) playerScores[r.osu_id] = {};
    playerScores[r.osu_id][r.challenge_id] = parseFloat(r.score_val);
  });

  const compPoints = {};
  CHALLENGES.forEach(cfg => {
    const ranked = Object.entries(playerScores)
      .map(([id, s]) => ({ id, v: s[cfg.id] || 0 }))
      .filter(p => p.v > 0)
      .sort((a, b) => cfg.sortOrder === 'asc' ? a.v - b.v : b.v - a.v);
    ranked.forEach((p, i) => {
      compPoints[p.id] = (compPoints[p.id] || 0) + Math.ceil(50 * Math.pow(0.8, i));
    });
  });

  return players.map(pl => {
    const puzzles  = playerPuzzles[pl.osu_id] || [];
    const puzzlePt = puzzles.reduce((sum, pid) => {
      const cnt = cntMap[pid] || 0;
      return sum + (cnt <= 1 ? 40 : Math.ceil(30 / cnt));
    }, 0);
    const compPt = compPoints[pl.osu_id] || 0;
    return {
      osu_id: pl.osu_id, name: pl.name,
      puzzle_point: puzzlePt, comp_point: compPt,
      total: puzzlePt + compPt,
    };
  }).sort((a, b) => b.total - a.total);
}

app.get('/api/leaderboard', async (req, res) => {
  try { res.json({ ok: true, data: await buildLeaderboard() }); }
  catch(e) { res.status(500).json({ ok: false, msg: 'Lỗi leaderboard' }); }
});

app.get('/api/leaderboard/full', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT puzzle_id, COUNT(*) as cnt FROM puzzle_completions GROUP BY puzzle_id`
    );
    const completedCounts = {};
    rows.forEach(r => { completedCounts[r.puzzle_id] = parseInt(r.cnt); });
    res.json({ ok: true, data: await buildLeaderboard(), completedCounts });
  } catch(e) { res.status(500).json({ ok: false, msg: 'Lỗi leaderboard full' }); }
});

app.get('/api/leaderboard/challenges', async (req, res) => {
  try {
    const { rows: players } = await pool.query(`SELECT osu_id, name FROM players`);
    const { rows: scoreRows } = await pool.query(`SELECT osu_id, challenge_id, score_val FROM challenge_scores`);
    const scoreMap = {};
    scoreRows.forEach(r => {
      if (!scoreMap[r.osu_id]) scoreMap[r.osu_id] = Array(CHALLENGES.length).fill(0);
      scoreMap[r.osu_id][r.challenge_id] = parseFloat(r.score_val);
    });
    res.json({ ok: true, data: players.map(pl => ({
      osu_id: pl.osu_id, name: pl.name,
      scores: scoreMap[pl.osu_id] || Array(CHALLENGES.length).fill(0),
    }))});
  } catch(e) { res.status(500).json({ ok: false, msg: 'Lỗi challenge scores' }); }
});

app.get('/api/lastchanged', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT GREATEST(
        COALESCE((SELECT MAX(completed_at) FROM puzzle_completions),'epoch'),
        COALESCE((SELECT MAX(updated_at)   FROM challenge_scores),  'epoch')
      ) AS ts`
    );
    res.json({ ok: true, lastChanged: new Date(rows[0].ts).getTime() });
  } catch(e) { res.json({ ok: true, lastChanged: 0 }); }
});

// ════════════════════════════════════════════════════════════
// PLAYER DATA
// ════════════════════════════════════════════════════════════

app.get('/api/player/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const { rows: pr } = await pool.query(`SELECT osu_id, name FROM players WHERE osu_id=$1`, [uid]);
    if (!pr.length) return res.json({ ok: false, msg: 'Player not found' });

    const { rows: pzRows } = await pool.query(
      `SELECT puzzle_id FROM puzzle_completions WHERE osu_id=$1`, [uid]
    );
    const { rows: scRows } = await pool.query(
      `SELECT challenge_id, score_val FROM challenge_scores WHERE osu_id=$1`, [uid]
    );

    const quizzes = Array(30).fill(false);
    pzRows.forEach(r => { quizzes[r.puzzle_id] = true; });
    const scores = Array(CHALLENGES.length).fill(0);
    scRows.forEach(r => { scores[r.challenge_id] = parseFloat(r.score_val); });

    res.json({ ok: true, data: { osuId: uid, name: pr[0].name, quizzes, scores } });
  } catch(e) { res.status(500).json({ ok: false, msg: 'Lỗi player data' }); }
});


// ════════════════════════════════════════════════════════════
// SUBMIT SCORE (Competition)
// ════════════════════════════════════════════════════════════

app.post('/api/score/submit', auth, async (req, res) => {
  const { challengeIndex } = req.body;
  const cfg = CHALLENGES[challengeIndex];
  if (!cfg)           return res.status(400).json({ ok: false, msg: 'Challenge không tồn tại' });
  if (!cfg.beatmapId) return res.status(500).json({ ok: false, msg: `BEATMAP_ID_${challengeIndex} chưa set` });

  const uid = req.user.uid;

  let token;
  try { token = await getOsuToken(); }
  catch(e) { return res.status(500).json({ ok: false, msg: 'Không lấy được osu! token' }); }

  let plays;
  try {
    const r = await fetch(
      `https://osu.ppy.sh/api/v2/users/${uid}/scores/recent?limit=5&include_fails=0&mode=osu&legacy_only=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return res.status(500).json({ ok: false, msg: `osu! API lỗi ${r.status}` });
    plays = await r.json();
  } catch(e) {
    await log('error', 'score_submit_osu_api', uid, { challengeIndex, msg: e.message });
    return res.status(500).json({ ok: false, msg: 'Lỗi kết nối osu! API' });
  }

  if (!Array.isArray(plays) || !plays.length)
    return res.json({ ok: false, msg: 'Chưa có play nào gần đây. Hãy chơi rồi Submit!' });

  const mapPlays = plays.filter(p => String(p.beatmap?.id) === String(cfg.beatmapId));
  if (!mapPlays.length)
    return res.json({ ok: false, msg: 'Không tìm thấy play trên map này trong 5 lần gần nhất.' });

  const best = [...mapPlays].sort((a, b) => {
    const va = extractVal(a, cfg.scoreType), vb = extractVal(b, cfg.scoreType);
    return cfg.sortOrder === 'asc' ? va - vb : vb - va;
  })[0];

  const scoreVal = extractVal(best, cfg.scoreType);

  const { rows } = await pool.query(
    `SELECT score_val FROM challenge_scores WHERE osu_id=$1 AND challenge_id=$2`,
    [uid, challengeIndex]
  );
  const cur = rows.length ? parseFloat(rows[0].score_val) : 0;
  const better = cur === 0 ||
    (cfg.sortOrder === 'desc' && scoreVal > cur) ||
    (cfg.sortOrder === 'asc'  && scoreVal < cur);

  if (better) {
    await pool.query(
      `INSERT INTO challenge_scores (osu_id, challenge_id, score_val, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (osu_id, challenge_id) DO UPDATE SET score_val=$3, updated_at=NOW()`,
      [uid, challengeIndex, scoreVal]
    );
    await log('info', 'score_updated', uid, { challengeIndex, old: cur, new: scoreVal });
  }

  res.json({ ok: true, updated: better, newScore: better ? scoreVal : cur,
    play: { score_val: scoreVal, score_label: cfg.scoreLabel } });
});

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES — chỉ admin uid được phép
// ════════════════════════════════════════════════════════════

// Logs với filter và pagination
app.get('/api/admin/logs', auth, adminOnly, async (req, res) => {
  try {
    const { level, action, uid, limit = 100, offset = 0 } = req.query;
    const conditions = [];
    const params     = [];

    if (level)  { params.push(level);  conditions.push(`level = $${params.length}`); }
    if (action) { params.push(`%${action}%`); conditions.push(`action ILIKE $${params.length}`); }
    if (uid)    { params.push(uid);    conditions.push(`osu_id = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await pool.query(
      `SELECT id, level, action, osu_id, detail, created_at
       FROM admin_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) as total FROM admin_logs ${where}`,
      params.slice(0, -2)
    );
    res.json({ ok: true, logs: rows, total: parseInt(cnt[0].total) });
  } catch(e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Danh sách players
app.get('/api/admin/players', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.osu_id, p.name, p.created_at,
        (SELECT COUNT(*) FROM puzzle_completions pc WHERE pc.osu_id = p.osu_id) AS puzzle_count,
        (SELECT COUNT(*) FROM challenge_scores   cs WHERE cs.osu_id = p.osu_id) AS score_count
      FROM players p ORDER BY p.created_at DESC
    `);
    res.json({ ok: true, players: rows });
  } catch(e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Xóa score của 1 player (1 challenge)
app.delete('/api/admin/score', auth, adminOnly, async (req, res) => {
  const { osu_id, challenge_id } = req.body;
  if (!osu_id || challenge_id === undefined)
    return res.status(400).json({ ok: false, msg: 'Missing params' });
  await pool.query(
    `DELETE FROM challenge_scores WHERE osu_id=$1 AND challenge_id=$2`,
    [osu_id, parseInt(challenge_id)]
  );
  await log('warn', 'admin_delete_score', req.user.uid, { target: osu_id, challenge_id });
  res.json({ ok: true });
});

// Xóa puzzle completion của 1 player
app.delete('/api/admin/puzzle', auth, adminOnly, async (req, res) => {
  const { osu_id, puzzle_id } = req.body;
  if (!osu_id || puzzle_id === undefined)
    return res.status(400).json({ ok: false, msg: 'Missing params' });
  await pool.query(
    `DELETE FROM puzzle_completions WHERE osu_id=$1 AND puzzle_id=$2`,
    [osu_id, parseInt(puzzle_id)]
  );
  await log('warn', 'admin_delete_puzzle', req.user.uid, { target: osu_id, puzzle_id });
  res.json({ ok: true });
});

// Thêm puzzle completion thủ công
app.post('/api/admin/puzzle', auth, adminOnly, async (req, res) => {
  const { osu_id, puzzle_id } = req.body;
  if (!osu_id || puzzle_id === undefined)
    return res.status(400).json({ ok: false, msg: 'Missing params' });
  await pool.query(
    `INSERT INTO puzzle_completions (osu_id, puzzle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [osu_id, parseInt(puzzle_id)]
  );
  await log('warn', 'admin_add_puzzle', req.user.uid, { target: osu_id, puzzle_id });
  res.json({ ok: true });
});

// Stats tổng quan
app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [pl, pz, sc, lg] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS c FROM players`),
      pool.query(`SELECT COUNT(*) AS c FROM puzzle_completions`),
      pool.query(`SELECT COUNT(*) AS c FROM challenge_scores`),
      pool.query(`SELECT COUNT(*) AS c FROM admin_logs WHERE created_at > NOW() - INTERVAL '24h'`),
    ]);
    res.json({
      ok: true,
      players:   parseInt(pl.rows[0].c),
      puzzles:   parseInt(pz.rows[0].c),
      scores:    parseInt(sc.rows[0].c),
      logs_24h:  parseInt(lg.rows[0].c),
    });
  } catch(e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
