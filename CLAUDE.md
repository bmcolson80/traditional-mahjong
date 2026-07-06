# Traditional Mahjong

Real-time multiplayer Traditional Chinese Mahjong. Built on GAMESTACK (see global
`~/.claude/CLAUDE.md` for the base stack/patterns — this file only covers what's
specific to this project, or what GAMESTACK doesn't already tell you).

## Quick facts
- Files: `server.js` (WS + REST), `game.js` (pure game logic, no I/O), `ai.js`
  (AI opponents), `db.js` (sql.js wrapper), `public/index.html` (entire frontend:
  markup + CSS + vanilla JS in one file)
- Test command: `npm run test:all` (unit + e2e + regression) — run this before
  considering any `server.js` or `game.js` change done. Currently 105 tests
  across 34 suites (verified against `origin/main` on 2026-07-05).
- Deployed on Railway, auto-deploys on push to `main`. GitHub Actions
  (`.github/workflows/ci.yml`) runs the full `npm run test:all` suite on every
  push and PR, but CI does not gate the Railway deploy — a red build doesn't
  stop the push from shipping.
- GitHub: `bmcolson80/traditional-mahjong`. Deploys are direct pushes to `main`
  (small hobby project, no PR review step, no merge commits).
- My in-game handle is "Colsman".

## Hard-won lessons from this project specifically

**Local checkout can silently drift behind `origin/main`.** Nothing about a
stale local `main` announces itself — no error, no warning — it just quietly
means the file you're reading/editing/previewing isn't what's actually
deployed. This already happened once: local `main` sat 19 commits behind
`origin/main` (missing an entire board-visual redesign — table frame, tile
wall, dealer-wind tile — plus host-tracking and test-suite work), and a local
dev-server preview was mistaken for a look at production. Before trusting a
local file as "what's deployed" — especially when a screenshot or behavior
looks surprisingly out of date — run `git fetch origin && git log
origin/main..HEAD` and `git log HEAD..origin/main` to check for drift in
either direction, not just `git status`.

**`room.currentDiscard` staleness.** It's set when a player discards and must be
cleared the instant *anyone* draws (`drawTile()` in `game.js`), not just when a
claim happens. If it lingers, two different things break: (1) the claim window
UI logic gets confused about who can claim what, and (2) self-draw win detection
misidentifies the winning tile, causing valid winning hands to be rejected as
"does not qualify" — the hand loocks fine to the eye but the server checks a
tile that isn't even in it. If a "why won't this valid hand let me declare
Mahjong" report ever comes up again, always ask for the exact tiles from the
error message (see the tile-count guard in `declare_win`) before assuming it's a
detection-algorithm bug — it usually isn't.

**Host tracking (`hostUserId` / `hostPlayerId`).** This bit us hard and took
several rounds to fully fix. See the "Host / ownership tracking" section in the
global CLAUDE.md — this project is the reason that section exists. If host-only
controls (End Game, Start Game, Add AI) ever mysteriously disappear for someone
who should clearly still be the host, this is almost certainly why. Check
`isRoomHost()` in `server.js` and the `/api/my-games` `isHost` computation first.

**Already-corrupted persisted rooms don't self-heal from a code fix alone.** A
server-side fix only prevents *future* corruption. A room already sitting in the
DB with bad data (e.g. a stale 15-tile hand, or a stale `hostPlayerId`) stays
broken until something actually touches that specific room again — a rejoin, an
action, etc. Don't assume "I deployed the fix" means "that specific game is
fixed now." When debugging a report against an old game, always check whether
it's the *same* room across multiple bug reports (same room code / same
player names) — if so, the fix needs to actually run against that room's data,
not just exist in the codebase.

**Action bar double-fire guard.** `#actionBar` is a persistent DOM node (only
`innerHTML` gets wiped between renders). The guard flag
(`bar.dataset.actionTaken`) must be reset at the top of every `renderActionBar()`
call, or the first click of the session permanently disables every action button
for the rest of the session. This exact regression happened once already —
don't reintroduce it if this function gets refactored.

**Tile rendering (`tileSVG` and friends).** Tile faces are generated as SVG, not
images. Each numbered tile (Dots/Bamboo/Characters 1-9, Flowers/Seasons 1-4) and
each named tile (winds E/S/W/N, dragons) has a small corner label (number or
letter) baked in via `withCornerLabel()` — this exists specifically so tiles are
identifiable without reading Chinese. Don't remove it when touching tile
graphics. Dragon corner labels: `RD`→C, `GD`→F, `WD`→B (Chung/Fa/Blank).

**Layout**: the discard tile sits *below* the exposed-sets panel (not above) so
it stays visible even when multiple players have several melds on screen. The
action bar sits directly above the hand section, not at the very bottom of the
page — both were deliberate fixes for mobile reachability, not arbitrary.

**Round-wind indicator.** The small wind tile (東/南/西/北) shown next to the
dealer's score chip is a functional element, not decorative — it updates as the
round wind changes and should stay pinned next to whichever seat is currently
dealer.

## Testing this project locally
- `DB_PATH=/tmp/whatever.db JWT_SECRET=test-secret PORT=<port> node server.js`
  — always pair with a fresh `rm -f` of the db path first for a clean run.
- Playwright is available for real end-to-end browser verification against a
  running local server — prefer this over pure code inspection when a bug report
  is about UI behavior (button visibility, click flows, layout).
- Remember: start the server and run the verification script in the *same*
  shell invocation. A background server started in one command does not survive
  into the next one in this environment.
