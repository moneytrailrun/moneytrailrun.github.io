import { createHash } from 'node:crypto';

const MAX_PENDING_RUNS = 2048;
const CHECKPOINT_PREFIX = 'MONEYTRAIL_RANK ';
const MAX_SCORE = 9_000_000_000_000;
const VALID_ID = /^[a-f0-9]{64}$/;
const VALID_RUN = /^[a-f0-9]{32}$/;

const UPDATE_PROFILE = `
  INSERT INTO ranked_players (identity, display_name, country, seen_at)
  VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
  ON CONFLICT (identity) DO UPDATE SET display_name = EXCLUDED.display_name,
    country = EXCLUDED.country, seen_at = EXCLUDED.seen_at
  WHERE ranked_players.seen_at < EXCLUDED.seen_at`;
const UPDATE_RUN = `
  INSERT INTO ranked_runs (run_id, player, best, collected)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (run_id) DO UPDATE SET
    best = greatest(ranked_runs.best, EXCLUDED.best),
    collected = greatest(ranked_runs.collected, EXCLUDED.collected)
  WHERE ranked_runs.player = EXCLUDED.player
    AND (ranked_runs.best < EXCLUDED.best OR ranked_runs.collected < EXCLUDED.collected)`;

export async function saveCheckpoint(pool, event) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(UPDATE_PROFILE, [event.player, event.name, event.country, event.receivedAt]);
    await client.query(UPDATE_RUN, [event.run, event.player, event.best, event.total]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function parseCheckpoint(line) {
  if (!line.startsWith(CHECKPOINT_PREFIX) || line.length > 1024) return null;
  try {
    const event = JSON.parse(line.slice(CHECKPOINT_PREFIX.length));
    if (!VALID_ID.test(event.player ?? '') || !VALID_RUN.test(event.run ?? '')) return null;
    if (typeof event.country !== 'string' || !/^([A-Z]{2})?$/.test(event.country)) return null;
    if (typeof event.name !== 'string' || !event.name.trim() || Array.from(event.name).length > 16 ||
        /[\u0000-\u001f\u007f]/.test(event.name)) return null;
    if (![event.best, event.total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_SCORE)) return null;
    return { ...event, receivedAt: Date.now() };
  } catch {
    return null;
  }
}

function addResponseHeaders(request, response, publicOrigin) {
  response.setHeader('Vary', 'Origin');
  if (request.headers.origin === publicOrigin) response.setHeader('Access-Control-Allow-Origin', publicOrigin);
}

function reply(response, status, body, cache = 'no-store') {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(body));
}

export function makeLeaderboard(connectionString, publicOrigin) {
  let pool;
  let initialized;
  let retry;
  let writing = false;
  const pending = new Map();
  const boards = new Map();

  async function getPool() {
    if (!connectionString) throw new Error('Leaderboard disabled');
    initialized ??= (async () => {
      const { Pool } = await import('pg');
      if (!pool) {
        pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 15_000, query_timeout: 7000, statement_timeout: 6000 });
        pool.on('error', () => console.warn('An idle leaderboard database connection closed.'));
      }
      await pool.query('SELECT 1 FROM ranked_players LIMIT 0');
      return pool;
    })().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }

  async function flush() {
    if (writing || retry || !pending.size) return;
    writing = true;
    try {
      const db = await getPool();
      for (const [run, event] of pending) {
        await saveCheckpoint(db, event);
        if (pending.get(run) === event) pending.delete(run);
      }
    } catch {
      console.warn('Leaderboard checkpoint could not be saved; retrying.');
      retry = setTimeout(() => { retry = undefined; void flush(); }, 4000);
      retry.unref();
    } finally {
      writing = false;
    }
  }

  function consume(line) {
    if (!line.startsWith(CHECKPOINT_PREFIX)) return false;
    if (!connectionString) return true;
    const event = parseCheckpoint(line);
    if (event && (pending.has(event.run) || pending.size < MAX_PENDING_RUNS)) {
      pending.set(event.run, event);
      void flush();
    }
    return true;
  }

  async function respond(request, response) {
    const route = request.url?.split('?', 1)[0];
    if (route !== '/leaderboard' && route !== '/leaderboard/me') return false;
    addResponseHeaders(request, response, publicOrigin);
    if (request.method === 'OPTIONS' && request.headers.origin === publicOrigin) {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': '600',
      }).end();
      return true;
    }
    if (request.method !== 'GET') {
      reply(response, 405, { error: 'Method not allowed' });
      return true;
    }
    const mine = route.endsWith('/me');
    const token = mine && /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
    if (mine && !token) {
      reply(response, 401, { error: 'Player profile required' });
      return true;
    }
    const sort = new URL(request.url, 'https://leaderboard.invalid').searchParams.get('sort') === 'total' ? 'total' : 'best';
    try {
      const db = await getPool();
      if (mine) {
        const identity = createHash('sha256').update(token).digest('hex');
        const { rows } = await db.query('SELECT best::text, total::text FROM ranked_players WHERE identity = $1', [identity]);
        reply(response, 200, rows[0] ?? { best: '0', total: '0' });
      } else {
        const now = Date.now();
        if (!boards.has(sort) || now >= boards.get(sort).expires) {
          const result = await db.query(`SELECT display_name AS name, country, best::text, total::text
            FROM ranked_players WHERE ${sort} > 0 ORDER BY ${sort} DESC, identity LIMIT 50`);
          boards.set(sort, { expires: now + 15_000, rows: result.rows });
        }
        reply(response, 200, { rows: boards.get(sort).rows }, 'public, max-age=15');
      }
    } catch {
      reply(response, 503, { error: 'Leaderboard temporarily unavailable' });
    }
    return true;
  }

  async function close() {
    const stopAt = Date.now() + 5500;
    clearTimeout(retry);
    retry = undefined;
    void flush();
    while ((writing || pending.size) && Date.now() < stopAt) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    clearTimeout(retry);
    if (pool) await pool.end();
  }

  return { consume, respond, close };
}
