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
