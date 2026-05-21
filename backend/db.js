import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      osu_id      TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      avatar      TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS puzzle_completions (
      osu_id       TEXT REFERENCES players(osu_id),
      puzzle_id    INTEGER NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (osu_id, puzzle_id)
    );

    CREATE TABLE IF NOT EXISTS challenge_scores (
      osu_id       TEXT REFERENCES players(osu_id),
      challenge_id INTEGER NOT NULL,
      score_val    NUMERIC NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (osu_id, challenge_id)
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id          SERIAL PRIMARY KEY,
      level       TEXT NOT NULL DEFAULT 'info',
      action      TEXT NOT NULL,
      osu_id      TEXT,
      detail      JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS admin_logs_created_idx ON admin_logs(created_at DESC);
  `);
  console.log('✓ DB schema ready');
}

export async function log(level, action, osu_id = null, detail = {}) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (level, action, osu_id, detail) VALUES ($1,$2,$3,$4)`,
      [level, action, osu_id, JSON.stringify(detail)]
    );
  } catch(e) {
    console.error('log error:', e.message);
  }
}
