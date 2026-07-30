CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  tz               TEXT NOT NULL,
  goal_type        TEXT NOT NULL,
  goal_text        TEXT,
  height_in        INTEGER,
  start_weight     REAL,
  bed_target       TEXT,
  wake_target      TEXT,
  sleep_hours_goal REAL,
  water_goal       INTEGER DEFAULT 3,
  move_goal        INTEGER DEFAULT 2,
  push_sub         TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  type         TEXT NOT NULL,
  ts_utc       TEXT NOT NULL,
  local_date   TEXT NOT NULL,
  local_time   TEXT NOT NULL,
  tz           TEXT NOT NULL,
  qty          REAL,
  activity     TEXT,
  duration_min INTEGER,
  bed_at       TEXT,
  wake_at      TEXT,
  hours        REAL,
  mood         TEXT,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, local_date);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(local_date);

CREATE TABLE IF NOT EXISTS nudges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  to_user   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  ts_utc    TEXT NOT NULL
);

-- One row per missed day, used only to dedupe the cron's crew-wide alert
-- push so it fires once per (user, missed day, severity) instead of every
-- hourly tick. Current on-screen highlight state is computed live from
-- checkins, not from this table.
CREATE TABLE IF NOT EXISTS streak_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  missed_date TEXT NOT NULL,
  level       TEXT NOT NULL,   -- 'grace' (1st missed day) | 'escalate' (2nd in a row)
  ts_utc      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_streak_alerts_dedup
  ON streak_alerts(user_id, missed_date, level);

INSERT OR IGNORE INTO users
  (id, name, tz, goal_type, goal_text, height_in, start_weight,
   bed_target, wake_target, sleep_hours_goal, water_goal, move_goal, created_at)
VALUES
  ('ray',    'Ray',    'America/New_York', 'recomp',
   'Lose 25 lb fat · gain 15 lb muscle', 72, 254.0,
   '22:30', '06:00', 7.5, 3, 2, '2024-01-01T00:00:00Z'),

  ('evan',   'Evan',   'America/New_York', 'consistency',
   'Show up every day', 74, 297.0,
   '23:00', '07:00', 8.0, 3, 2, '2024-01-01T00:00:00Z'),

  ('daniel', 'Daniel', 'America/Chicago',  'tone',
   'Cut the belly fat · tone up', 72, 170.0,
   '22:30', '06:30', 7.0, 3, 2, '2024-01-01T00:00:00Z');
