const USER_ORDER = ['ray', 'evan', 'daniel'];

// ── helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getCORSHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed =
    origin === 'https://red.builtbyvega.com' ||
    /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://red.builtbyvega.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function addDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function subtractDays(dateStr, n = 1) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function withinMinutes(actual, target, tolerance) {
  const diff = Math.abs(timeToMinutes(actual) - timeToMinutes(target));
  return Math.min(diff, 1440 - diff) <= tolerance;
}

// ── VAPID / push ──────────────────────────────────────────────────────────────

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlToBuf(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const str = atob(b64);
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
  return buf;
}

function b64urlJson(obj) {
  const str = JSON.stringify(obj);
  let b64 = '';
  for (let i = 0; i < str.length; i++) b64 += String.fromCharCode(str.charCodeAt(i));
  return btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function vapidHeaders(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 43200;

  const header  = b64urlJson({ typ: 'JWT', alg: 'ES256' });
  const payload = b64urlJson({ aud: audience, exp, sub: 'mailto:vegajunkmail@gmail.com' });
  const toSign  = `${header}.${payload}`;

  // Build JWK from raw private (32 B) + uncompressed public key (65 B: 0x04 + x + y)
  const pubBytes = b64urlToBuf(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: env.VAPID_PRIVATE_KEY,
    x: bufToB64url(pubBytes.slice(1, 33)),
    y: bufToB64url(pubBytes.slice(33, 65)),
  };

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${bufToB64url(sig)}`;
  return {
    Authorization: `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
    TTL: '43200',
  };
}

async function sendPush(pushSubJson, env) {
  const sub = typeof pushSubJson === 'string' ? JSON.parse(pushSubJson) : pushSubJson;
  try {
    const headers = await vapidHeaders(sub.endpoint, env);
    const res = await fetch(sub.endpoint, { method: 'POST', headers });
    return res.ok || res.status === 201;
  } catch {
    return false;
  }
}

// ── scoring ───────────────────────────────────────────────────────────────────

function computeMarks(checkins, user) {
  const waterLogs = checkins.filter(c => c.type === 'water');
  const moveLogs  = checkins.filter(c => c.type === 'move');
  const sleepLog  = checkins.find(c => c.type === 'sleep');
  const moodLog   = checkins.find(c => c.type === 'mood');

  const water = [waterLogs.length >= 1, waterLogs.length >= 2, waterLogs.length >= 3];
  const move  = [moveLogs.length >= 1,  moveLogs.length >= 2];

  let sleep = [false, false, false];
  if (sleepLog) {
    const bedOk = user.bed_target && sleepLog.bed_at
      ? withinMinutes(sleepLog.bed_at, user.bed_target, 30) : false;
    const wakeOk = user.wake_target && sleepLog.wake_at
      ? withinMinutes(sleepLog.wake_at, user.wake_target, 30) : false;
    const hoursOk = user.sleep_hours_goal != null && sleepLog.hours != null
      ? sleepLog.hours >= user.sleep_hours_goal : false;
    sleep = [bedOk, wakeOk, hoursOk];
  }

  return { water, move, sleep, mood: [!!moodLog] };
}

function marksToPoints(marks) {
  return (
    marks.water.filter(Boolean).length +
    marks.move.filter(Boolean).length +
    marks.sleep.filter(Boolean).length +
    marks.mood.filter(Boolean).length
  );
}

function computeStreak(userCheckins, user, asOfDate) {
  const todayPts = marksToPoints(computeMarks(userCheckins[asOfDate] || [], user));
  let date  = todayPts >= 6 ? asOfDate : subtractDays(asOfDate, 1);
  let streak = 0;
  for (let i = 0; i < 90; i++) {
    const pts = marksToPoints(computeMarks(userCheckins[date] || [], user));
    if (pts >= 6) { streak++; date = subtractDays(date, 1); }
    else { break; }
  }
  return streak;
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleCheckin(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const {
    user_id, type, ts_utc, local_date, local_time, tz,
    qty, activity, duration_min, bed_at, wake_at, hours, mood, note,
  } = body;

  if (!user_id || !type || !ts_utc || !local_date || !local_time || !tz) {
    return json({ error: 'Missing required fields: user_id, type, ts_utc, local_date, local_time, tz' }, 400, corsHeaders);
  }

  const validTypes = ['water', 'move', 'sleep', 'mood', 'weight'];
  if (!validTypes.includes(type)) {
    return json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400, corsHeaders);
  }

  const result = await env.DB.prepare(
    `INSERT INTO checkins
       (user_id, type, ts_utc, local_date, local_time, tz,
        qty, activity, duration_min, bed_at, wake_at, hours, mood, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    user_id, type, ts_utc, local_date, local_time, tz,
    qty ?? null, activity ?? null, duration_min ?? null,
    bed_at ?? null, wake_at ?? null, hours ?? null,
    mood ?? null, note ?? null,
  ).run();

  return json({ ok: true, id: result.meta.last_row_id }, 200, corsHeaders);
}

async function handleFeed(url, env, corsHeaders) {
  let date = url.searchParams.get('date');
  const tz     = url.searchParams.get('tz');
  const viewer = url.searchParams.get('viewer');

  if (!date) {
    date = tz
      ? new Date().toLocaleDateString('en-CA', { timeZone: tz })
      : new Date().toISOString().slice(0, 10);
  }

  const orderExpr = `CASE id WHEN 'ray' THEN 1 WHEN 'evan' THEN 2 WHEN 'daniel' THEN 3 ELSE 4 END`;
  const { results: users } = await env.DB.prepare(
    `SELECT * FROM users ORDER BY ${orderExpr}`
  ).all();

  const startDate = subtractDays(date, 90);
  const { results: allCheckins } = await env.DB.prepare(
    `SELECT * FROM checkins
     WHERE local_date >= ? AND local_date <= ?
     ORDER BY local_date DESC, ts_utc DESC`
  ).bind(startDate, date).all();

  const checkinMap = {};
  for (const ck of allCheckins) {
    if (!checkinMap[ck.user_id]) checkinMap[ck.user_id] = {};
    if (!checkinMap[ck.user_id][ck.local_date]) checkinMap[ck.user_id][ck.local_date] = [];
    checkinMap[ck.user_id][ck.local_date].push(ck);
  }

  const usersOut = users.map(user => {
    const userCheckins  = checkinMap[user.id] || {};
    const todayCheckins = userCheckins[date]  || [];
    const marks         = computeMarks(todayCheckins, user);
    const points        = marksToPoints(marks);
    const streak        = computeStreak(userCheckins, user, date);
    const weightLoggedToday = todayCheckins.some(c => c.type === 'weight');

    return {
      id: user.id, name: user.name, tz: user.tz,
      goal_type: user.goal_type, goal_text: user.goal_text,
      streak, points, total: 9, marks,
      weight_logged_today: weightLoggedToday,
    };
  });

  // Nudges sent to the viewer in the last 24h
  let nudges = [];
  if (viewer) {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT from_user, kind, ts_utc FROM nudges
       WHERE to_user = ? AND ts_utc >= ?
       ORDER BY ts_utc DESC LIMIT 10`
    ).bind(viewer, cutoff).all();
    nudges = results;
  }

  return json({ date, users: usersOut, nudges }, 200, corsHeaders);
}

async function handleMe(url, env, corsHeaders) {
  const user_id = url.searchParams.get('user');
  if (!user_id) return json({ error: 'Missing user param' }, 400, corsHeaders);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first();
  if (!user) return json({ error: 'User not found' }, 404, corsHeaders);
  return json(user, 200, corsHeaders);
}

async function handleSubscribe(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }
  const { user_id, subscription } = body;
  if (!user_id || !subscription) return json({ error: 'Missing fields' }, 400, corsHeaders);

  await env.DB.prepare('UPDATE users SET push_sub = ? WHERE id = ?')
    .bind(JSON.stringify(subscription), user_id)
    .run();

  return json({ ok: true }, 200, corsHeaders);
}

async function handleNudge(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }
  const { from, to, kind } = body;
  if (!from || !to || !kind) return json({ error: 'Missing fields' }, 400, corsHeaders);
  const validKinds = ['proud', 'lets_go', 'checking_in', 'nice_work', 'get_up'];
  if (!validKinds.includes(kind)) return json({ error: 'Invalid kind' }, 400, corsHeaders);

  await env.DB.prepare(
    `INSERT INTO nudges (from_user, to_user, kind, ts_utc) VALUES (?, ?, ?, ?)`
  ).bind(from, to, kind, new Date().toISOString()).run();

  // Deliver push to recipient
  const target = await env.DB.prepare('SELECT push_sub FROM users WHERE id = ?').bind(to).first();
  if (target?.push_sub) {
    await sendPush(target.push_sub, env);
  }

  return json({ ok: true }, 200, corsHeaders);
}

async function handleHistory(url, env, corsHeaders) {
  const user_id = url.searchParams.get('user');
  const days    = Math.min(parseInt(url.searchParams.get('days') || '90'), 365);

  if (!user_id) return json({ error: 'Missing user param' }, 400, corsHeaders);

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first();
  if (!user) return json({ error: 'User not found' }, 404, corsHeaders);

  const endDate   = new Date().toLocaleDateString('en-CA', { timeZone: user.tz });
  const startDate = subtractDays(endDate, days);

  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM checkins WHERE user_id = ? AND local_date >= ? ORDER BY ts_utc DESC`
  ).bind(user_id, startDate).all();

  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.local_date]) byDate[r.local_date] = [];
    byDate[r.local_date].push(r);
  }

  const daily = [];
  let cur = startDate;
  while (cur <= endDate) {
    const dayCk = byDate[cur] || [];
    const marks  = computeMarks(dayCk, user);
    daily.push({
      date:         cur,
      points:       marksToPoints(marks),
      water_count:  dayCk.filter(c => c.type === 'water').length,
      sleep_hours:  dayCk.find(c => c.type === 'sleep')?.hours ?? null,
      move_minutes: dayCk.filter(c => c.type === 'move').reduce((s, c) => s + (c.duration_min || 0), 0),
    });
    cur = addDay(cur);
  }

  const weeklyWeight = rows
    .filter(r => r.type === 'weight' && r.qty != null)
    .map(r => ({ date: r.local_date, lbs: r.qty }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return json({
    user_id, tz: user.tz,
    goal: { sleep_hours: user.sleep_hours_goal, water: user.water_goal },
    streak:       computeStreak(byDate, user, endDate),
    total_points: daily.reduce((s, d) => s + d.points, 0),
    daily, weekly_weight: weeklyWeight,
    log: rows,
  }, 200, corsHeaders);
}

// ── cron reminders ────────────────────────────────────────────────────────────

// Local hours at which we fire a reminder (7am 10am noon 3pm 6pm 9pm)
const REMINDER_HOURS = [7, 10, 12, 15, 18, 21];

async function runReminders(env) {
  const { results: users } = await env.DB.prepare(
    'SELECT * FROM users WHERE push_sub IS NOT NULL'
  ).all();

  const now = new Date();

  for (const user of users) {
    // Resolve user's current local hour
    const localHour = parseInt(
      now.toLocaleTimeString('en-US', { timeZone: user.tz, hour: '2-digit', hour12: false })
    ) % 24;

    if (!REMINDER_HOURS.includes(localHour)) continue;

    // Check today's points — skip if already green (6+)
    const localDate = now.toLocaleDateString('en-CA', { timeZone: user.tz });
    const { results: checkins } = await env.DB.prepare(
      'SELECT * FROM checkins WHERE user_id = ? AND local_date = ?'
    ).bind(user.id, localDate).all();

    const points = marksToPoints(computeMarks(checkins, user));
    if (points >= 6) continue;

    await sendPush(user.push_sub, env);
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const corsHeaders = getCORSHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/checkin'   && request.method === 'POST') return handleCheckin(request, env, corsHeaders);
      if (path === '/api/feed'      && request.method === 'GET')  return handleFeed(url, env, corsHeaders);
      if (path === '/api/me'        && request.method === 'GET')  return handleMe(url, env, corsHeaders);
      if (path === '/api/subscribe' && request.method === 'POST') return handleSubscribe(request, env, corsHeaders);
      if (path === '/api/nudge'     && request.method === 'POST') return handleNudge(request, env, corsHeaders);
      if (path === '/api/history'   && request.method === 'GET')  return handleHistory(url, env, corsHeaders);
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500, corsHeaders);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
