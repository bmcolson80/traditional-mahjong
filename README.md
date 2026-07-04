# Traditional Mahjong — Real-Time Multiplayer

A 2, 3, or 4-player Traditional (Chinese/Classical) Mahjong game: Express + WebSocket server,
sql.js persistence, JWT auth, optional email OTP password reset, and optional
web push notifications. Vanilla JS frontend, mobile-first.

## What's implemented

- **Auth**: register/login with bcrypt + JWT (30-day httpOnly cookie), 3-step OTP password reset
- **Game engine** (`game.js`): full 144-tile wall, dealing, draw/discard, pung/kong/chow claims
  (chow restricted to the discarder's immediate right, as per traditional rules), win detection
  for standard hands, Seven Pairs, and Thirteen Orphans, and a basic fan-based scorer
- **WebSocket server**: authoritative server-side game state, room creation/joining, all the
  standard message types, wrapped in try/catch with `{ type: 'error' }` replies
- **Push notifications**: VAPID-based, degrades gracefully if not configured
- **Tests**: 23 tests across unit (`game.test.js`), end-to-end WebSocket (`e2e.test.js`), and
  regression (`regression.test.js`) — all passing

## Run locally

```bash
npm install
npm test          # unit tests only
npm run test:all  # unit + e2e + regression
npm start          # starts on http://localhost:3000
```

No env vars are required to run locally — `JWT_SECRET` falls back to a dev value, and
email/push features silently no-op if `RESEND_API_KEY` / `VAPID_*` aren't set (OTP codes get
logged to the console instead of emailed).

## Deploy to Railway — step by step

**Why Railway + a volume:** sql.js keeps the whole database in memory and writes a single
file to disk on every change. Railway's ephemeral filesystem gets wiped on every redeploy,
so without a persistent volume your users and games would vanish every time you push a fix.

1. **Push this project to a GitHub repo.**
   ```bash
   cd mahjong
   git init && git add -A && git commit -m "Initial Mahjong app"
   git branch -M main
   git remote add origin https://github.com/<you>/mahjong.git
   git push -u origin main
   ```

2. **Create a new Railway project** → "Deploy from GitHub repo" → pick your repo.
   Railway auto-detects Node via Nixpacks; `railway.json` in this repo tells it to run
   `node server.js`.

3. **Add a persistent volume** (this is the step people usually skip and then lose their DB):
   - In your Railway service → **Settings → Volumes → New Volume**
   - Mount path: `/data`
   - This is why `DB_PATH=/data/mahjong.db` matters below — it points sql.js at the volume
     instead of the ephemeral container disk.

4. **Set environment variables** — Service → **Variables** → paste these in (see
   `.env.example` in this repo for the same list):
   ```
   JWT_SECRET=<generate a long random string>
   RESEND_API_KEY=<from resend.com, optional — leave blank to disable email>
   EMAIL_DOMAIN=<your verified sending domain in Resend>
   VAPID_PUBLIC_KEY=<optional, see step 5>
   VAPID_PRIVATE_KEY=<optional>
   VAPID_EMAIL=<your contact email>
   DB_PATH=/data/mahjong.db
   NODE_ENV=production
   ```
   Generate `JWT_SECRET` quickly with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

5. **(Optional) Generate VAPID keys for push notifications:**
   ```bash
   npx web-push generate-vapid-keys
   ```
   Paste the public/private pair into the Railway variables above. If you skip this, the
   app still works — the push toggle in the UI just stays disabled.

6. **Deploy.** Railway will build and start the service automatically on push. Check the
   deploy logs for `Mahjong server listening on port ...` to confirm it booted.

7. **Verify persistence works**: create an account, then trigger a redeploy (e.g. push an
   empty commit). Log in again — if your account still exists, the volume is wired up
   correctly. If not, double check the volume's mount path is exactly `/data` and that
   `DB_PATH` matches.

## Fixing bugs going forward

Since state lives in `rooms` (in-memory, per-server-instance) and `games`/`game_players`
(persisted snapshot in sql.js), most gameplay bugs will show up as a thrown error inside
`handleMessage` in `server.js` — check your Railway logs for the `handleMessage error:` line,
which includes the message type and stack trace. Game logic itself is isolated in `game.js`
with no side effects on `req`/`res`/`ws`, so you can usually reproduce and fix a bug by adding
a regression test in `test/regression.test.js` first, confirming it fails, then patching
`game.js` until `npm run test:all` is green again.
