# Room 1 QA run (Claude, 4 Nov 2026, 04:18-04:31)

Setup: backend main=bcef9ff via S7's steps in local (S9) mode, frontend room1-demo=388c889 standalone on :5173.
Test player: qa_0418 (local only). Trail: ~/skillbreak-work/apm0039582-projecthon-team5/room1-trail.log

| # | Check | Result |
|---|---|---|
| 1 | Sign up, sign out, sign in again (Enter key) | PASS |
| 2 | Start game, countdown, sandbox "Ready" (J1 provision fix live) | PASS |
| 3 | employees 24 rows, logs 150 rows, join finds Dana's hash (puzzle solved), UPDATE blocked with clear message | PASS |
| 3 | Copy a cell | PASS (fallback path: pane has no clipboard permission; text selected + "copy manually", never "Copied"). Success path not seen. |
| 4 | Decoy password_change hash -> "No match found."; Dana's hash -> password + inventory note | PASS |
| 5 | Wrong password -> error; right one -> Dana's desktop, stays open after RoomEntered | PASS |
| 6 | Open room -> door opens -> room 02 "Coming soon" | PASS (second game) |
| 7 | Reload mid-game -> state comes back | FAIL: reload signs the player out (tokens in memory by design); after sign-in, Start game creates a NEW game. Resume needs the requestId kept across reload (GameApp.tsx). |
| 8 | All UI text English | PASS (0 Hebrew chars in DOM text/labels). Room-2 background picture has Hebrew handwriting in the image itself. |
| 9 | One sessionId per game, start/evaluate/relay/RoomEntered lines; secrets grep 0 (danaZ22, password, hash, Bearer, test password, JWT secret, internal token) | PASS (2 sessionIds only because of step 7) |
| 10 | Engine DB stopped ~6 s: only error name + code (Error code=ECONNREFUSED), max line 142 chars, recovered (/health 200) | PASS |
| 11 | Truncated output: notice + 65 rows; pg_sleep(10): "SQL execution timed out." after ~5 s, no lingering helper via the executor path; >5500 ms runtimeUnavailable covered by S9 unit tests | PASS |

## Demo risks found
1. `sh scripts/demo-room1.sh local` FAILS without the VPN: `docker compose run engine-migrate` depends on `workspace-init`, which runs `npm ci` against the corporate registry (404 off-VPN). Container node_modules volume lacks .bin, so migrate/seed inside containers fail too. Worked around by running the remaining steps on the host (migrations, seed:room1 with root .env preloaded, then node apps/local-runtime/dist/main.js). Fix options: VPN up at 9 AM, or an S7 change (skip workspace-init; run migrate/seed on the host as the script already does for kind).
2. Step 7 (reload) does not resume the game (see above).

## Visual check against the design HTML (04:5x)
Same pictures as the design (hash-cracker, login screen, desktop, open-room icon). Differences:
1. BUG: `.t5-zoom button` (game.css L14, specificity 0,1,1) beats `.screen-action` (0,1,0): CRACK, Log In and the open-room icon get a dark box (bg rgb(41,47,52), min-height 42px, padding 9px 16px). Hides the green CRACK and blue Log In drawn in the pictures; the open-room icon shrinks inside a dark tile.
2. BUG: Dana login inputs use the device input style (near-white text, no fill) on the picture's white fields -> typed username invisible. Design has `.screen-input.login-input` (white fill, dark text).
3. Hash output: design `.screen-output` = green text on dark green; ours = plain light text (readable).
4. SQL screen: design = sqlite> terminal with text table; ours = query box + Run + grid with Copy per cell (as the brief/spec 005 US1 asked).
5. Errors: design shows a red bar on the device picture and clears the password; ours shows text below the picture.
Fixed 04:5x in room1-demo=32ee351: items 1, 2, 3 (design CSS ported). Items 4 (SQL grid by spec) and 5 (error placement, polish cut) kept as is.
