# R.E.D. Accountability App — Build Spec

**Target:** Claude Code, Mac Mini
**Deploy:** `red.builtbyvega.com` (Cloudflare Pages) + Worker API (Cloudflare Workers + D1)
**Users:** Exactly three. Ray, Evan, Daniel. No signup, no auth server, no growth path.
**Owner:** Dan Vega / Built by Vega

---

## 0. Read this first

This app has one job: three men who love each other keep each other honest, daily, across two time zones, for as long as it stays useful. Every feature below either serves that or should be cut.

Two design rules that override convenience:

1. **The first screen is the other two guys, not a form.** The app opens on Crew. Logging is a deliberate second action.
2. **Nothing scores weight loss.** Points come from consistency only. Ray (44ish, 6'0", 254) and Evan (16, 6'2", 297) and Dan (6'0", 170) have wildly different bodies and goals. A leaderboard on pounds is rigged and everyone knows it.

Evan is 16. His goal type is `consistency`. His card never displays a weight delta or a target. He logs weight weekly like the others, but his headline metric is streak.

---

## 1. Architecture

Two Cloudflare projects.

**A. Pages project** — static PWA, auto-deploy from GitHub on push to main. Custom domain `red.builtbyvega.com`. Contents: `index.html` (single file, everything inline), `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`.

**B. Worker** — API + hourly cron + push sender. Bound to D1. Route it at `red-api.builtbyvega.com` or leave it on `*.workers.dev` for v1. CORS allow-origin is the Pages domain.

> **Verify before building:** Workers now support serving static assets directly (the `assets` binding), which could collapse this to one project. I'm not confident enough in the current config syntax to spec it. Check the live Cloudflare docs; if the single-Worker path is clean, take it — one deploy, no CORS. Otherwise use the two-project layout above, which I'm confident works.

**Why not Pages Functions for the API:** Pages Functions bind to D1 fine, but scheduled/cron handlers are a Workers feature. Since reminders are core, the Worker is required regardless.

---

## 2. D1 schema

Database name: `red-accountability`

Flat. Sparse columns instead of JSON blobs — SQLite handles nulls cheaply and it keeps every query one level deep.

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,        -- 'ray' | 'evan' | 'daniel'
  name            TEXT NOT NULL,
  tz              TEXT NOT NULL,           -- 'America/Chicago' | 'America/New_York'
  goal_type       TEXT NOT NULL,           -- 'recomp' | 'consistency' | 'tone'
  goal_text       TEXT,                    -- human-readable, shown on Me tab only
  height_in       INTEGER,
  start_weight    REAL,
  bed_target      TEXT,                    -- 'HH:MM' local
  wake_target     TEXT,                    -- 'HH:MM' local
  sleep_hours_goal REAL,
  water_goal      INTEGER DEFAULT 3,
  move_goal       INTEGER DEFAULT 2,
  push_sub        TEXT,                    -- JSON PushSubscription, null until granted
  created_at      TEXT NOT NULL
);

CREATE TABLE checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  type         TEXT NOT NULL,   -- 'water' | 'move' | 'sleep' | 'mood' | 'weight'
  ts_utc       TEXT NOT NULL,   -- ISO 8601 UTC, source of truth
  local_date   TEXT NOT NULL,   -- 'YYYY-MM-DD' in the logger's tz
  local_time   TEXT NOT NULL,   -- 'HH:MM' in the logger's tz
  tz           TEXT NOT NULL,   -- tz at time of logging
  qty          REAL,            -- water: ounces | weight: lbs
  activity     TEXT,            -- move: 'Walk','Lift','Bike','Basketball','Yard work','Other'
  duration_min INTEGER,         -- move
  bed_at       TEXT,            -- sleep: 'HH:MM'
  wake_at      TEXT,            -- sleep: 'HH:MM'
  hours        REAL,            -- sleep
  mood         TEXT,            -- mood: label from the wheel
  note         TEXT             -- mood write-in, or any freeform
);

CREATE INDEX idx_checkins_user_date ON checkins(user_id, local_date);
CREATE INDEX idx_checkins_date ON checkins(local_date);

CREATE TABLE nudges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  to_user   TEXT NOT NULL,
  kind      TEXT NOT NULL,   -- 'proud' | 'lets_go' | 'checking_in' | 'nice_work' | 'get_up'
  ts_utc    TEXT NOT NULL
);
```

**Timezone rule, non-negotiable:** `ts_utc` is truth. `local_date` is computed client-side from the logger's own tz at write time and stored. Evan logging at 11:40pm Eastern buckets to Evan's Tuesday, not Dan's Wednesday. Never re-derive `local_date` on the server from a different zone. Streaks and day-completion query `local_date` only.

Seed the three users in the migration. Dan: `America/Chicago`. Ray and Evan: `America/New_York`.

---

## 3. Worker API

All JSON. No auth token — three people, private subdomain, trust model is the group chat itself. Do not build accounts.

```
POST /api/checkin       body: full checkin row minus id. Returns {ok, id}.
GET  /api/feed?date=    All three users' day summary + points for a local_date. Default: today per requester tz (passed as ?tz=).
GET  /api/history?user=&type=&days=   Rows for charting.
POST /api/nudge         body: {from, to, kind}. Writes row, fires push to `to` immediately.
POST /api/subscribe     body: {user, subscription}. Stores push_sub.
GET  /api/me?user=      User row incl. targets.
POST /api/targets       Update bed/wake/hours/goals.
```

Return the feed as computed points, not raw rows — the client should not be recalculating scores.

### Cron

Schedule `0 * * * *` (hourly). On each tick the Worker loops all three users, converts UTC now into each user's local hour, and fires only what matches:

| Local time | Push |
|---|---|
| 10:00, 14:00, 18:00 | Water reminder — text pairs the reminder with one rotating food item |
| 12:00, 19:00 | Move with purpose |
| Hour containing `bed_target` minus 30 min | Wind-down |
| 08:00 | Sleep + mood check if not yet logged today |
| Sunday 09:00 | Weekly weigh-in |

Five to six pushes a day is the ceiling. **Do not add a separate food notification.** The food line rides along inside the water push. A sixth ping is how all three of them turn off notifications in week two.

Suppress a reminder if that goal is already met for the local day. Nobody should get a water ping after their third glass.

### Web Push — take the easy path

Sign VAPID JWTs (ES256, P-256) with Web Crypto in the Worker. Generate the keypair once locally with `npx web-push generate-vapid-keys`; public key goes in the client, private key goes in as a Wrangler secret.

**Send payloadless pushes.** Do not implement aes128gcm payload encryption in the Worker — that is the single most likely place to burn an unplanned hour. Instead: the push is a bare wake-up signal, and `sw.js` handles `push` by fetching `/api/feed` and building the notification text locally, then calling `showNotification`. Same user experience, roughly a fifth of the crypto.

> **iOS constraint, must be handled in UI:** Web Push on iOS requires iOS 16.4+ **and** the app installed via Add to Home Screen. It does not work from a Safari tab. All three are on iPhones. See §6 on the install gate.

---

## 4. Scoring

Nine points available per day.

| Item | Points |
|---|---|
| Water log ×3 | 1 each = 3 |
| Move log ×2 | 1 each = 2 |
| In bed within 30 min of `bed_target` | 1 |
| Awake within 30 min of `wake_target` | 1 |
| Slept ≥ `sleep_hours_goal` | 1 |
| Mood check | 1 |

Sleep scores partial credit on purpose. A guy who went to bed late but still got 7.5 hours did something right and should not see a zero.

**Green day** = 6 or more of 9. **Streak** = consecutive green days by `local_date`. Not 9/9 — a perfectionist threshold breaks on the first bad Tuesday and never recovers.

Weekly weigh-in is worth 2 points, Sunday only, and sits outside the daily nine. It is optional every week and skipping it never breaks a streak.

Weight is charted raw, weekly. No rolling average needed now that we're off daily weigh-ins — seven days is already the smoothing.

---

## 5. Screens

Four tabs, bottom nav: **Crew · Log · Progress · Me**

### Crew (default landing)

Three white cards stacked on the navy ground, one per person, in R-E-D order. Each card shows name, day streak, a one-line goal, and the nine-mark row. That's it — no charts, no weight on this screen.

**The nine-mark row replaces any progress ring.** Nine small vertical bars in a single line, grouped 3 · 2 · 3 · 1 with visible gaps and a mono label under each group: Water, Move, Sleep, Mood. Empty bar is a hairline navy outline; filled bar is solid red. Score reads as `8/9` in mono at the right edge.

Do not substitute a ring. A ring reports "8 of 9" and nothing else; the grouped row shows at a glance that Ray drank his water, moved twice, and never logged sleep. The scoring model is discrete, so the display should be too.

Tapping a card opens a nudge sheet: five preset sends, one tap each, fires a push to that person immediately.

- Proud of you
- Let's go today
- Checking in on you
- Nice work
- Get up, old man

Received nudges appear as a small stack at the top of Crew for 24 hours, showing who sent what. This is the signature element of the app and the only thing on any screen that arrives without being scheduled. Keep everything around it quiet.

### Log

Four quick actions, sized for thumbs.

- **Water** — one tap logs a glass. Ounce chips (8 / 16 / 24) default to 16, adjustable but never required. Must complete in under two seconds.
- **Move** — activity chip plus a duration chip (15 / 30 / 45 / 60 / custom). Two taps, done.
- **Sleep** — two time pickers pre-filled with the user's targets, hours auto-computed. Morning only.
- **Mood** — ten-option grid plus a write-in field.

Mood options: Energized · Motivated · Content · Calm · Neutral · Tired · Stressed · Frustrated · Anxious · Down · plus "Something else" with a text field.

On Sundays a weight card appears at the top of Log and disappears once logged. It never appears on other days.

### Progress

Per-user, switchable between the three. Streak and total points up top. Then hand-rolled SVG line charts — no Chart.js, no CDN dependency:

- Weight, weekly points, plotted raw
- Sleep hours, daily, with the goal as a horizontal rule
- Movement minutes per day, bar
- Water completion rate, last 30 days

Below that, a reverse-chronological timestamped log — date and local time on every row, since that was an explicit requirement.

### Me

Name, tz, sleep targets, goal text, notification permission state, and a re-run of the install walkthrough. Editable targets.

---

## 6. First run and the install gate

This is the highest-risk moment in the product. If Ray opens it in a Safari tab, grants nothing, and never installs, the app looks broken and dies that week.

Flow: pick your name (three big cards) → confirm timezone → set bed target, wake target, hours goal → **install gate** → notification permission → Crew.

The install gate detects `window.navigator.standalone`. If not installed, it shows an illustrated Add to Home Screen walkthrough and **does not let the user proceed to notification permission**. Requesting permission before install fails silently on iOS and burns the prompt. Say plainly what's happening: reminders only work once the app is on the home screen.

Store the chosen user id in localStorage. That's the only thing localStorage holds. All check-in data lives in D1 — that's the whole point.

---

## 7. Food library

Thirty items, hardcoded as a flat array in the client. One rotating card on Crew, below the three user cards. Also feeds the text of the water pushes.

Constraints, all real: **no shellfish** (Ray, allergy). **Low sodium** (Ray). Fresh over processed. Nothing requiring a specialty store — everything findable at a Walmart in eastern PA near the Poconos. Nothing that reads as health-store bait to a 16-year-old.

**Snacks:** apple with peanut butter · banana with peanut butter · hard-boiled eggs · string cheese · unsalted almonds · unsalted peanuts · plain Greek yogurt with honey · plain Greek yogurt with berries · grapes · clementines · strawberries · blueberries · baby carrots with hummus · celery with peanut butter · cucumber slices · bell pepper strips · sugar snap peas · cherry tomatoes · watermelon · pineapple · deli turkey rolled around a cheese stick · avocado toast · oatmeal with peanut butter stirred in · banana and a glass of milk · chocolate milk after a workout

**Meals:** rotisserie chicken with frozen broccoli or green beans · baked chicken thighs with rice · burgers on a bun with roasted potatoes instead of the frozen fries · taco night with ground turkey · spaghetti with a leaner meat sauce · scrambled eggs with turkey and toast for dinner · frozen salmon fillet · pork loin

Three items are deliberate introductions rather than staples: hummus, plain yogurt they sweeten themselves instead of pre-sugared cups, and salmon. Each sits next to something they already eat so none of them announces itself as an experiment.

**Copy rule:** name the item and stop. No macros, no calorie counts, no "swap this for that," no nutrition-app voice. Framing is always add-this, never avoid-that. That matters generally and it matters more with a 16-year-old in the group.

---

## 8. Visual direction

**Approved against `red-crew-mockup.html` v5. That file is the reference — build to it, not to the previous BbV site tokens.** R.E.D. deliberately diverges from Built by Vega's identity: no Syne, no #FF5910 orange. This is a family tool, not a BbV client product.

```css
--navy:       #002D72;   /* card type, header ground */
--navy-deep:  #001B45;   /* app background */
--white:      #ffffff;   /* person card fill */
--peri:       #BAC8F2;   /* nudge bubbles ONLY */
--red:        #D32F2F;   /* accent on light grounds */
--red-bright: #FF4A3D;   /* accent on navy grounds */
--ink:        #20345c;   /* body type on periwinkle */
--muted:      #5f6b85;   /* secondary type on light */
--mark-off:   rgba(0,45,114,.26);  /* empty mark outline */
```

**Two reds, and Code must not collapse them.** `--red` is unreadable on navy — muddy, low contrast. Anywhere red sits on a navy ground, use `--red-bright`. Currently that's exactly two places: the periods in the wordmark and the active bottom-nav tab. Everywhere else on white, use `--red`.

**Red is accent only.** Marks, streak numbers, the wordmark periods, the active nav tab, and the nudge dot. Nothing in this app carries a solid red fill — solid red reads as an error state on every other app on their phones, and nothing here should ever flag a person as failing.

**Periwinkle appears exactly once:** the nudge bubbles at the top of Crew. That single-use rule is what makes an incoming message from Ray or Evan legible at a glance without shouting. If a second periwinkle element ever gets added, the signal breaks.

**Type: Inter throughout.** Names at 38px / weight 600 / letter-spacing -0.025em. Supporting lines at weight 300. JetBrains Mono earns its place in three spots only — timestamps, mark group labels, and the `8/9` score — where fixed-width columns make a month of check-ins scan like a ledger. That contrast, expressive sans up top and rigid mono in the data, is the whole personality.

**Grounds:** navy-deep app background, white person cards, periwinkle bubbles. Navy is the frame; white is the field. Header wordmark is white letters with red-bright periods.

> Check the wordmark on a real iPhone before locking it. At 18px with .22em tracking the periods are small enough that the red may read as a rendering artifact. If they vanish, bump the wordmark size — do not change the color.

### Scroll architecture — use this exactly

This pattern is settled from the previous app. Do not improvise a replacement.

```css
html, body { overflow: hidden; height: 100%; }
#app       { position: fixed; inset: 0 0 var(--nav-h) 0; }
.tab       { position: absolute; inset: 0; display: flex; flex-direction: column; }
.tab-head  { flex-shrink: 0; }
.tab-body  { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
```

Respect `prefers-reduced-motion`. Visible keyboard focus. Two animations exist in the entire app: a mark filling on tap, and a nudge bubble settling in on arrival. Everything else is still. Restraint is what separates understated from unfinished.

---

## 9. Build order

1. Schema + seed the three users, verify with a local D1 query
2. Worker: `/api/checkin` and `/api/feed`, no push yet
3. Frontend: Crew and Log against the live API — get them logging before anything else exists
4. Progress charts
5. Push: subscribe, VAPID signing, payloadless send, service worker fetch-and-show
6. Cron reminders with per-user local-time evaluation
7. Nudges
8. Food library
9. Install gate and first-run

Ship after step 4 if it's working. They can start using it that night and the reminders can land three days later.

---

## 10. Deploy sequence

```bash
npx wrangler d1 create red-accountability
# paste the returned database_id into wrangler.toml under [[d1_databases]]

npx wrangler d1 execute red-accountability --remote --file=./schema.sql

npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PRIVATE_KEY
# public key goes in the client source

npx wrangler deploy
```

Then in the Cloudflare dashboard: create the Pages project from the GitHub repo, add `red.builtbyvega.com` as a custom domain through the Pages dashboard directly. Do not hand-write the DNS record — adding the custom domain through Pages is what fixed the 522 on `www.builtbyvega.com` last time.

> **Verify:** Wrangler's CLI flags shift between major versions. Run `npx wrangler --help` and `npx wrangler d1 execute --help` before trusting the exact syntax above. The command names are stable; the flags are what move.

---

## 11. Cost

Zero incremental. Pages is free, the Worker is free at roughly a hundred requests a day, D1's free tier is far above three men generating about six thousand rows a year, Web Push is a browser standard with no vendor, and the subdomain rides on a domain already paid for.

> **Verify:** D1 free-tier limits are the number I'm least confident in — Cloudflare has repriced storage products more than once and this figure predates May 2026. The order of magnitude isn't in question; check the dashboard rather than taking the specific numbers on faith.

The $99/year Apple Developer fee applies only to a future Capacitor wrap, which buys exactly one thing worth having: Apple Health pulling steps and sleep automatically. Not now. Capacitor wraps this same codebase later with no rewrite.

---

## 12. Out of scope for v1

Food logging. Calorie or macro tracking. Recipes. Workout programming. iMessage relay via AppleScript on the Mac Mini — real, probably workable, deliberately deferred until the app itself has proven it gets used. Accounts, invites, or any fourth user.
