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

// ── scoring ───────────────────────────────────────────────────────────────────

// Returns { water: [bool,bool,bool], move: [bool,bool], sleep: [bool,bool,bool], mood: [bool] }
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
      ? withinMinutes(sleepLog.bed_at, user.bed_target, 30)
      : false;
    const wakeOk = user.wake_target && sleepLog.wake_at
      ? withinMinutes(sleepLog.wake_at, user.wake_target, 30)
      : false;
    const hoursOk = user.sleep_hours_goal != null && sleepLog.hours != null
      ? sleepLog.hours >= user.sleep_hours_goal
      : false;
    sleep = [bedOk, wakeOk, hoursOk];
  }

  const mood = [!!moodLog];

  return { water, move, sleep, mood };
}

function marksToPoints(marks) {
  return (
    marks.water.filter(Boolean).length +
    marks.move.filter(Boolean).length +
    marks.sleep.filter(Boolean).length +
    marks.mood.filter(Boolean).length
  );
}

// Walk backward from asOfDate counting consecutive green days (6+).
// If today is not yet green (empty or in progress), start from yesterday —
// so a single 8am water log doesn't collapse a 21-day streak.
// Any fully missed day in the walk has pts=0 and immediately breaks the streak.
function computeStreak(userCheckins, user, asOfDate) {
  const todayPts = marksToPoints(computeMarks(userCheckins[asOfDate] || [], user));
  let date  = todayPts >= 6 ? asOfDate : subtractDays(asOfDate, 1);
  let streak = 0;

  for (let i = 0; i < 90; i++) {
    const pts = marksToPoints(computeMarks(userCheckins[date] || [], user));
    if (pts >= 6) {
      streak++;
      date = subtractDays(date, 1);
    } else {
      break;
    }
  }

  return streak;
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleCheckin(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
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
    qty          ?? null,
    activity     ?? null,
    duration_min ?? null,
    bed_at       ?? null,
    wake_at      ?? null,
    hours        ?? null,
    mood         ?? null,
    note         ?? null,
  ).run();

  return json({ ok: true, id: result.meta.last_row_id }, 200, corsHeaders);
}

async function handleFeed(url, env, corsHeaders) {
  let date = url.searchParams.get('date');
  const tz  = url.searchParams.get('tz');

  if (!date) {
    date = tz
      ? new Date().toLocaleDateString('en-CA', { timeZone: tz })
      : new Date().toISOString().slice(0, 10);
  }

  // Load all three users in R-E-D order
  const orderExpr = `CASE id WHEN 'ray' THEN 1 WHEN 'evan' THEN 2 WHEN 'daniel' THEN 3 ELSE 4 END`;
  const { results: users } = await env.DB.prepare(
    `SELECT * FROM users ORDER BY ${orderExpr}`
  ).all();

  // Load 90 days of check-ins for all three users in one query
  const startDate = subtractDays(date, 90);
  const { results: allCheckins } = await env.DB.prepare(
    `SELECT * FROM checkins
     WHERE local_date >= ? AND local_date <= ?
     ORDER BY local_date DESC, ts_utc DESC`
  ).bind(startDate, date).all();

  // Group by user → date → rows[]
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

    const weightLoggedToday = (userCheckins[date] || []).some(c => c.type === 'weight');

    return {
      id:                  user.id,
      name:                user.name,
      tz:                  user.tz,
      goal_type:           user.goal_type,
      goal_text:           user.goal_text,
      streak,
      points,
      total:               9,
      marks,
      weight_logged_today: weightLoggedToday,
    };
  });

  return json({ date, users: usersOut }, 200, corsHeaders);
}

async function handleMe(url, env, corsHeaders) {
  const user_id = url.searchParams.get('user');
  if (!user_id) return json({ error: 'Missing user param' }, 400, corsHeaders);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first();
  if (!user) return json({ error: 'User not found' }, 404, corsHeaders);
  return json(user, 200, corsHeaders);
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
  // Push delivery wired in step 7
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
    `SELECT * FROM checkins
     WHERE user_id = ? AND local_date >= ?
     ORDER BY ts_utc DESC`
  ).bind(user_id, startDate).all();

  // Group by date
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.local_date]) byDate[r.local_date] = [];
    byDate[r.local_date].push(r);
  }

  // Daily summaries — every date in the window, including days with no check-ins.
  // Missed days get zeroes so they occupy space in charts rather than disappearing.
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

  // Weight logs ascending (weekly weigh-ins)
  const weeklyWeight = rows
    .filter(r => r.type === 'weight' && r.qty != null)
    .map(r => ({ date: r.local_date, lbs: r.qty }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return json({
    user_id,
    tz:           user.tz,
    goal: {
      sleep_hours: user.sleep_hours_goal,
      water:       user.water_goal,
    },
    streak:       computeStreak(byDate, user, endDate),
    total_points: daily.reduce((s, d) => s + d.points, 0),
    daily,
    weekly_weight: weeklyWeight,
    log:           rows,   // already descending by ts_utc
  }, 200, corsHeaders);
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
      if (path === '/api/checkin' && request.method === 'POST') {
        return handleCheckin(request, env, corsHeaders);
      }
      if (path === '/api/feed' && request.method === 'GET') {
        return handleFeed(url, env, corsHeaders);
      }
      if (path === '/api/me' && request.method === 'GET') {
        return handleMe(url, env, corsHeaders);
      }
      if (path === '/api/nudge' && request.method === 'POST') {
        return handleNudge(request, env, corsHeaders);
      }
      if (path === '/api/history' && request.method === 'GET') {
        return handleHistory(url, env, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500, corsHeaders);
    }
  },
};
