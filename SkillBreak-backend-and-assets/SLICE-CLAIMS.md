# SLICE-CLAIMS (claims, slice plans, merge evidence)

## Step 0 log
- 03:09 room1-sql:local build FAILED with public.npmrc: `replace-registry-host=always` swaps host only, keeps corporate path /artifactory/api/npm/<repo>/ -> npmjs 404. Corporate host unreachable (VPN route down).
- 03:15 room1-sql:local built OK (239f9aab548d) from a scratch copy of sandboxes/sql with lockfile URLs rewritten to registry.npmjs.org (integrity hashes unchanged). Repo untouched.
- FE work copy: branch room1-demo, push DISABLED, .claude/ + github/ excluded.

- FE install (npm install --no-save --no-package-lock, public.npmrc): exit 0; package.json/lockfile status unchanged.
- FE baseline: npx vitest run src/teams/team5 -> 7 files, 31/31 pass.
- 03:09 Grok wave 0 done: skillbreak-cleanup.sh delivered (read by Claude: Safe items only, refuses .env/*.tgz). Note from Grok: exclude needs `/local/` (root-anchored), baseline tree e84d0b9.
- BLOCKER for backend `npm ci`: its lockfile resolves 632 packages from artifact.it.att.com / jfrog-pkg-proxy.it.att.com; same path issue as the image. Proposed: temp-rewrite lockfile URLs, npm ci, then `git checkout package-lock.json` (net zero). Awaiting Daniel.

## F0 plan (Claude, R1-R5)
Claim: F0 = files listed in brief §5 F0, all under src/teams/team5/. Branch team5/F0 off room1-demo.

Reused (searched with rg/grep first):
- `GameApi`, `ApiError` (game/api.ts); `PuzzleScreenProps` (screens/types.ts); `PuzzleInput` (contracts/outputs.ts)
- `trimSingleLineInput`, `copyTextToClipboard` (screens/room-1-ui.helpers.ts), no new helpers
- `ROOM_1_ASSETS` / `RoomAssetId` (room-design/room-assets.ts); `fakeViews` (dev/fakeViews.ts), extended in place
- `Team5Page` default export (index.ts) + `TEAMS` (src/teams.ts) for the standalone page; root `vite.config` via team5 `vite.local.config.ts`
- CSS naming: `t5-` prefix in game.css; the brief names `.screen-input`, `.screen-action`, `.interactive-screen` for device-screen.css

Files:
1. vite-env.d.ts: `/// <reference types="vite/client" />` only.
2. tsconfig.json: extends ../../../tsconfig.json; include team5 + src/teams.ts, src/teams/TeamLayout.tsx, src/teams/useTeamBackend.ts, src/api/teamApi.ts.
3. vite.standalone.config.ts: mergeConfig(vite.local.config, { root: standalone/ }).
4. standalone/index.html, main.tsx, StandaloneApp.tsx (+ StandaloneApp.test.tsx): render Team5Page with the team5 entry of TEAMS + src/App.css; no App/registry import.
5. game/logging/logger.ts (+ logger.test.ts): `logger.info/warn(event, { sessionId?, commandId?, puzzleKey?, status? })`, a whitelist of context keys so input/passwords/tokens can't be passed. Called from api.ts start/postInput.
6. SubmitResult moves to api.ts; screens/types.ts re-exports it (api.ts no longer imports screens/types.ts, so there is no cycle).
7. game/screens/shared/: `percentBox` (moved logic; same name and signature as the local helper in RoomFrame.tsx L48, which F4 swaps to the shared import, so there is no lasting copy), `DeviceScreen` (picture plus positioned inputs), `submitErrorMessage(SubmitResult)` (English text for the error codes; none exists today: RoomFrame only passes the result through), device-screen.css.
8. room-assets.ts + 3 PNGs in one commit. NEW KEYS: `hash-cracker-streight` (= file name); Dana files get keys WITHOUT "dana" because room-1.design.test.ts L23 asserts no asset key contains "dana" (it keeps character names editable): `computer-open-empty` -> danas-computer-open-empty.png, `open-doors-file` -> open-doors-file-in-danas-computer.png. F3 uses these keys.
9. fakeViews.ts: add the states the screens need (SQL rows TSV, syntax error, "SQL command failed", truncation notice, hash solved/rejected, login rejected/accepted).
10. AuthForm.tsx: remove the `if (auth)` panel (L45-55); GameApp renders AuthForm only when !auth. AuthForm.test.tsx has no test of that panel; checking it still passes.
11. vendor/README.md L20: drop the non-existent refresh.mjs step.

New names, and why no existing one fits (R5):
- `logger`: no logger exists (grep console. in team5 -> none).
- `DeviceScreen`: no picture-with-inputs component exists; ZoomPanel is the modal frame only.
- `submitErrorMessage`: no SubmitResult-to-text mapping exists.
- `percentBox`: existing, but local to RoomFrame (not exported); moved to shared.
- `StandaloneApp`: the brief names it.
- F0 additions to R5: `FakeViewName` (the Record key union grew from 5 to 9 names; a named type keeps the signature readable), `SQL_ROWS` (one TSV sample shared by the rows and truncated views), file `shared/submit-error.ts` (holds submitErrorMessage; .ts naming like auth-validation.ts).
- F0 note: AuthForm.test.tsx needed no change; none of its tests covered the removed panel.
- 03:16 F0 committed on team5/F0 = a98fcbe. tsc -p team5 exit 0; vitest 10 files 37/37 (31 + 6 new); standalone build to /tmp/team5-build OK; dev server :5173 serves index + modules; guard empty; 22 files, all F0-owned. PENDING: madge (npx download blocked by the auto-mode classifier, needs Daniel's OK). STATUS `done` line not appended until madge passes.
- 03:16 Backend still waiting: clean-up script not yet run (backend `env` still present).
- 03:17 madge on src/teams/team5: 64 files, 0 cycles. STATUS: wave 1 done F0=a98fcbe appended.
- 03:24 Daniel CONFIRMED the merge gate (tests pass + madge 0 + files match -> ff-only merge, no wait).
- 03:30 Backend baseline: main=d131a78, tree e84d0b9 (290 files) = Grok's. .env ignored (!!), /local/ excluded, no env/key files staged. (Brief's env grep regex misses the '!! ' prefix; checked with a corrected regex.)
- 03:31 Snapshot ~/Downloads/sb-snap-w1.tgz from main=d131a78 (no .env, no local/ or .local/ kubeconfig).
- 03:31 Backend npm ci (temp lockfile rewrite, restored): exit 0, git status clean.
- 03:32 S4 MERGED ff main=5ad6b78: tree 0336960 = Grok's; build:foundation 0; test:foundation 0 (contracts 6/6, messaging 19/19, gateway 72+16s, engine 201+128s); npm test 0; engine test 0; madge 0 (local-runtime/src not present yet); files only packages/messaging/**. test:sandbox:db deferred to after T0 per note.
- 03:33 S6 MERGED ff main=5f286e9: files = fixture only; engine test 0 (201+128s); real image (room1-sql:local d44712d) ready=true, current_user sandbox_player, employees 24, logs 150, password_change 10, auth 1, INSERT blocked.
- 03:34 T0 MERGED ff main=82bc0a4: files = 2 engine tests; test:sandbox:db 64/64 exit 0 (also covers S4+S6); test:foundation 0; engine test 0; madge unchanged (tests only).
- 03:37 S9 MERGED ff main=babeb5e: files = 3 (executor, its test, compose); unit 8/8; madge 0 (132 files, incl. local-runtime/src); engine 201+128s; live smoke on local/room1-sql:dev (tagged from verified room1-sql:local, compose up --no-build): healthy, ready, isolation net=none ro user 70:70 caps ALL pids 64, current_user sandbox_player, INSERT blocked + count 24, Dana SELECT via LocalContainerExecutor SOLVED, fresh token per query (+2 journal dirs). Step 8 (pg_sleep 10) FINDING: helper never returns after the 5 s stop and the process lingers (baseline query-helper.mjs L345 for-await after backend terminate; not S9 code). Reported to Grok.
- 03:37 F0 MERGED ff room1-demo=a98fcbe. Wave 1 merged: backend main=babeb5e, FE room1-demo=a98fcbe.
- 03:38 Snapshot ~/Downloads/sb-snap-w2.tgz from main=babeb5e (no .env/.local/dist).

## F3 plan (Claude, R1-R5)
Claim: F3 = src/teams/team5/game/screens/dana-login/{index.ts, DanaLoginScreen.tsx, DanaDesktop.tsx, dana-login-screen.test.tsx}. Branch team5/F3, worktree wt3.
Backend: dana-login template expects `{kind:'credentials', username, password}`; verdict 'solved' (output 'Accepted') or 'rejected' reason 'wrongAnswer'.
Reused: `PuzzleScreenProps` (screens/types.ts), `PuzzleInput` credentials kind (contracts/outputs.ts), `trimSingleLineInput` (room-1-ui.helpers.ts, username only; password never trimmed/logged), `DeviceScreen` + `percentBox` (shared/DeviceScreen.tsx), `.screen-input` / `.screen-action` (device-screen.css), `submitErrorMessage` (shared/submit-error.ts), `.t5-error` (game.css) for the error/rejection line under the screen, `ROOM_1_ASSETS['login-screen' | 'computer-open-empty' | 'open-doors-file']`, `fakeViews().login` in tests.
Design rects (the-last-tdp-exam-rooms 14.html showDanaLogin/showDanaDesktop): username [39.8,44.1,35.2,6.7], password [39.8,53.5,35.2,6.6], login [39.7,64.1,20,7.2], open-room file [54.8,37.6,8.1,12].
New names (R5): `DanaLoginScreen` (brief names it; no login screen exists), `DanaDesktop` (brief names it; F4 reuses it to keep the desktop after room 2), folder `dana-login/` + `index.ts` (brief names them).
- 03:43 S2-deps committed on branch S2-deps = 4b92920 (package.json + lockfile packages[""].dependencies, 1 line each). npm ci (temp URL rewrite, restored) exit 0; npm ls @team5/messaging clean. Waiting for Grok's final S2 (draft in wave2/ is on tree 0336960, pre-S6/T0/S9).

## F1 plan (Claude, R1-R5)
Claim: F1 = src/teams/team5/game/screens/idan-sql/{index.ts, sql-result.ts, sql-result.test.ts, IdanSqlScreen.tsx, idan-sql-screen.test.tsx, idan-sql-screen.css}. Branch team5/F1, worktree wt1.
Backend: sql input `{kind:'command', command}`; output = TSV (engine sandbox/sql-result.ts decodeSqlRows: header first, `\N` NULL, escapes `\\ \t \n \r`, ends with `\n`, no `\r`), or plain text: 'SQL syntax is invalid or unsupported.', 'SQL execution timed out.' (rejected sandboxRestarting), helper stderr ('SQL operation is not permitted.\n' etc., also 'SQL command failed'), 'SQL output truncated. Narrow the query.\n' + rows; rejected policyBlocked output ''.
Reused: `PuzzleScreenProps` (screens/types.ts), `PuzzleInput` command kind, `EvaluationView` (contracts/view.ts), `copyTextToClipboard` (room-1-ui.helpers.ts; no trim: multi-line queries kept, only blank rejected), `submitErrorMessage` (shared/submit-error.ts), `.t5-error` / `.t5-primary` (game.css), icons `Play` / `LoaderCircle` (vendor/icons), `fakeViews()` ready/starting/sqlRows/sqlSyntaxError/sqlFailed/sqlTruncated in tests. Not DeviceScreen (no device picture for the SQL terminal; the design shows a window, not an image).
Design (showTerminal 'sql'): window title 'Idan · SQL terminal', subtitle 'read-only · SELECT queries'; tables from fixture room1-sql-v1.sql GRANT SELECT: employees, logs.
New names (R5):
- `IdanSqlScreen` (brief names it; no SQL screen exists), folder `idan-sql/` + `index.ts` (brief names them).
- `readSqlResult(latestResult)` in sql-result.ts: no frontend TSV decoder exists (backend decodeSqlRows is in another repo and throws instead of falling back to text); returns `SqlOutcome`.
- `SqlOutcome` type: the one view model the screen renders (none | blocked | message | table); no existing type describes a decoded grid.
- CSS classes `t5-sql-*` in idan-sql-screen.css: no existing grid/terminal classes.

## F2 plan (Claude, R1-R5)
Claim: F2 = src/teams/team5/game/screens/hash-cracker/{index.ts, HashCrackerScreen.tsx, hash-cracker-screen.test.tsx} + src/teams/team5/game/room-1-progress.ts (+ .test.ts). Branch team5/F2, worktree wt2. No CSS file.
Backend: dana-hash (engine 'hash') expects `{kind:'answer', answer}` (64 hex, trimmed+lowercased server side); match -> verdict 'solved', output = password; decoy -> 'rejected' reason 'wrongAnswer'; bad format -> 'rejected' 'policyBlocked'.
Reused: `PuzzleScreenProps`, `PuzzleInput` answer kind, `trimSingleLineInput` + `copyTextToClipboard` (room-1-ui.helpers.ts), `DeviceScreen` + `percentBox`, `.screen-input` (also for the read-only output box, so no new CSS) / `.screen-action`, `submitErrorMessage`, `.t5-error` (game.css), `ROOM_1_ASSETS['hash-cracker-streight']`, `fakeViews().hash/.login` in tests.
Design rects (deviceConfigs.hash = [left,top,width,height]): input [15.5,47.4,49.8,7.7], output [15.5,64.9,64,7.8], CRACK [67.4,46.6,13.1,8.9]; checked against the 1536x1024 PNG.
New names (R5): `HashCrackerScreen` (brief names it; no hash screen exists), folder `hash-cracker/` + `index.ts` (brief), file `room-1-progress.ts` (spec 005 tasks T011 name), `Room1Progress` type + `readRoom1Progress`, `markPasswordCracked`, `setDanaDesktopOpen` (no session-scoped UI memory exists in team5; grep sessionStorage/progress/latch -> only a GameApp test assertion). Stores booleans only (the inventory note says "password cracked", it does not need the password text).
- 03:43 PRE-CHECK (branch pre-J1 = S2-deps + J1 + S7, not for merge): files match notes (7 local-runtime + README + demo-room1.sh); build:foundation 0; local-runtime build 0, test 13/13, typecheck 0, tsc --noUnused 0; madge 0 (141 files); sh -n demo-room1.sh 0. Will re-apply after S2 for the real merge.
- 03:44 F3 reviewed by Claude: commit 8802667 on team5/F3, 4 files (dana-login/**), tsc 0, vitest 42/42 in wt3. Credentials input, view-only result, password not trimmed/logged, icon -> close() only. Ready for wave 2 merge. F4 must keep DanaDesktop open across the room-2 move.
- F2 committed on team5/F2 = 16dc1a7. tsc -p team5 0; tsc noUnused 0; vitest 12 files 47/47 (37 + 10 new); guard empty; 5 files, all F2-owned.
- 03:45 F2 reviewed by Claude: commit 16dc1a7 on team5/F2, 5 files, tsc 0, vitest 47/47 in wt2. Answer input, password only from solved view, progress = 2 booleans in sessionStorage per session (no password stored). F4 TODO: RoomFrame also marks passwordCracked when hash-cracker solved; Dana latch via setDanaDesktopOpen; GameApp.test L72 asserts sessionStorage empty after sign-out (keep test off solved path or clear on sign-out). Spec 005 data-model said in-memory only; brief asked reload survival (QA step 7), sessionStorage kept.
- 03:45 F1 committed on team5/F1 = e7dd3fc. tsc -p team5 0; tsc --noUnused* 0; vitest 12 files 58/58 (37 + 21 new); guard empty; 6 files, all F1-owned.
- 03:46 Wave 2 FE combined (stacked in temp worktree 'combine'): F1=e7dd3fc F2=2050ded F3=63d926a on a98fcbe; tsc 0, strict tsc 0, vitest 15 files 73/73, guard empty (15 team5 files). Backend S2-deps=4b92920 ready; J1+S7 pre-checked.
- 03:56 S2-deps + S2 MERGED ff main=810cdb2: 25 files = note; build:foundation 0; test:foundation 0 (contracts 6, messaging 27, gateway 77+16s, engine 205+128s); engine integration 14/14; projection integration 17/17; sandbox:db 64/64; madge 0 (133). Not run: S2 step 4 (gateway Docker image, not used by the J1 demo path) and step 6 (manual engine start failure).
- 03:56 F1,F2,F3 MERGED ff room1-demo=63d926a (vitest 73/73 in main work copy). J1+S7 on new main (810cdb2): local-runtime 13/13, typecheck 0, tsc strict 0, sh -n 0, madge 0 (142). J1 HELD for Daniel's OK (provision-ready poll, local mode only).
- 04:07 Daniel OK in chat (04:0x) for J1. J1 + S7 MERGED ff main=ca3df17.
- 04:07 Snapshot sb-snap-w3.tgz from main=ca3df17.

## F4 plan (Claude, R1-R5)
Branch team5/F4 off room1-demo=63d926a. Files: new game/screens/index.ts; Team5Page.tsx; game/RoomFrame.tsx; game/RoomFrame.test.tsx; game/game.css. (GameApp.test.tsx: no change needed unless red.)
Reuse: IdanSqlScreen / HashCrackerScreen / DanaLoginScreen + DanaDesktop (screen index.ts files); readRoom1Progress, markPasswordCracked, setDanaDesktopOpen (game/room-1-progress.ts); percentBox (screens/shared/DeviceScreen, replacing RoomFrame's local copy, as F0 planned); ZoomPanel; room1Design characters/hotspots.
- screens/index.ts: `ROOM_1_SCREENS` = { 'idan-db', 'hash-cracker', 'dana-login' }; Team5Page passes it to GameApp (one prop).
- RoomFrame: progress state mirrored from room-1-progress; marks passwordCracked when hash-cracker is solved in the view; inventory note in the room footer.
- Room-2 fix: latch Dana's desktop when dana-login is seen solved OR the view leaves room-1 for room-2 during this mount (the server may project both in one view). While latched: room 1 stays displayed and Dana's desktop panel stays open (DanaDesktop); "Open room" or closing the panel clears the latch, then the existing door animation shows room 2. A reload with the latch set restores the held desktop.
New names (R5): `ROOM_1_SCREENS` (brief names it); `hotspotLabel` (dedupes the label expression RoomFrame already computes twice); `remember` (one place that writes progress and refreshes the state mirror); CSS `.t5-inventory` (no inventory style exists).
- 04:11 F4 committed on team5/F4: 49fab33 + review fix 388c889 (unexport SqlOutcome, Room1Progress). vitest 15 files 76/76, tsc 0, strict 0, build ok, madge 0, guard empty, unused-export check clean.
- 04:12 S1 MERGED ff main=bcef9ff (9 files = note; foundation 0: messaging 27, gateway 78+16s, engine 208+128s; engine int 14/14; projection int 17/17; sandbox:db 64/64; local-runtime 13/13; madge 0). F4 MERGED ff room1-demo=388c889 (76/76). Wave 3 merged.
- 04:18 QA player: qa_0418 (local test account; credentials in Claude scratchpad qa-player.txt).
- 04:25 QA run done: 10/11 pass, step 7 (reload resume) FAIL. Report: ~/skillbreak-work/QA-room1.md. Demo risk: demo-room1.sh needs VPN (workspace-init npm ci).
- 04:35 Daniel decided: QA step 7 (reload resume) NOT built. Demo rule: don't reload. Follow-up for the team (spec 005 left it out; PlayerReconnected contract unused).

## Visual fix plan (Claude, after QA visual check; Daniel chose "minimal CSS fix")
Branch team5/visual-fix off room1-demo=388c889. Files: game/screens/shared/device-screen.css, screens/dana-login/DanaLoginScreen.tsx, screens/hash-cracker/HashCrackerScreen.tsx.
- device-screen.css: port the design HTML's four device rules (.screen-input, .screen-input.login-input, .screen-output, .screen-action + hover/focus), scoped under .interactive-screen so they beat game.css L14-16 (.t5-zoom button 0,1,1; :disabled and :focus-visible 0,2,1). game.css untouched.
- DanaLoginScreen: both fields get the design's `login-input` class. HashCrackerScreen: output field uses the design's `screen-output` class (stays a read-only input; tests query it by label).
New names: none (CSS class names are the design HTML's own).
- 04:54 Visual fix MERGED ff room1-demo=32ee351 (3 files; tsc 0, strict 0, vitest 76/76, build ok, madge 0, guard empty). Visual re-check vs design: Hash-Cracker (green CRACK visible, green output) and Dana login (dark text on white fields, blue Log In visible) match; desktop button measured transparent, no padding, 75x75. Remaining small differences: open-room icon PNG has transparent margins so it shows ~2/3 of its area (design bakes the icon into the desktop picture); SQL screen is a grid by spec 005 (design: terminal); errors show below the picture.

## Port C plan (Claude subagent, R1-R5)
Branch team5/port-C (worktree .claude/worktrees/portC). Files: game/screens/shared/{DeviceScreen.tsx, DeviceScreen.test.tsx, device-screen.css}, game/screens/hash-cracker/{HashCrackerScreen.tsx, hash-cracker-screen.test.tsx}, game/screens/dana-login/{DanaLoginScreen.tsx, DanaDesktop.tsx, dana-login-screen.test.tsx}, assets/room-1/open-doors-file-in-danas-computer.png (crop only, same name).
- device-screen.css = design L76-97 rules (.interactive-screen + drop-shadow, width 100% kept; .screen-input, .login-input, .screen-output, .screen-action, .screen-error, .dana-file), scoped `.interactive-screen .x` as today so they beat game.css `.team5-game button` / `.t5-zoom button` (0,1,1) and their :disabled/:focus-visible (0,2,1). .screen-note not used by the design markup -> not ported.
- DeviceScreen: optional `onSubmit` renders the design's `form.interactive-screen` (else the div group); optional `className` for the design's `dana-desktop`.
- Hash: .modal-title "Hash Cracker", form with .screen-input / `<output class=screen-output>` / submit CRACK, .modal-note. Enter = native form submit (keyDown handler dropped to avoid double submit). Submit errors show in the device's output (design has no error element on this device). Copy password button dropped (design has none; output text stays selectable).
- Dana login: .modal-title "Dana's computer · Sign in" (name from room-1.design.json), login-input fields, "Log In" submit, .screen-error bar on the picture for view rejections and submit errors, password cleared + focused when a NEW rejection (commandId) arrives, .modal-note.
- Dana desktop: .modal-title / .interactive-screen.dana-desktop / .dana-file (CSS-positioned like the design) / .modal-note; click = close() only.
Reused: PuzzleScreenProps, DeviceScreen + percentBox, submitErrorMessage, trimSingleLineInput, ROOM_1_ASSETS, room1Design.characters, markPasswordCracked. New names: none beyond the design's own class names (`dana-desktop`, `screen-error`, `dana-file`).

## Port A plan (Claude, R1-R5)
Branch team5/port-A, worktree .claude/worktrees/portA. Files: game/ZoomPanel.tsx, game/RoomFrame.tsx (+ .test.tsx), game/GameApp.tsx (+ .test.tsx), game/game.css, game/room-design/room-1.design.json.
Design sources: design-code.html CSS 9-75, markup 451-466, rooms 492-511, showRoom 564, modal 674-690 + 1216-1245.
- ZoomPanel -> design modal: `.modal` (role=dialog, aria-label=title) > `.modal-close` "×" + `.modal-content` (tabIndex -1, focused on open). Esc closes; a click closes unless it (or the press that started it) is inside .interactive-screen/.window-shell/.desktop-scene or on a control (button/input/textarea/select/a/label: keeps "Copy password" etc. from closing). Tab trap kept (skips .xterm like the design L1240). Focus restore + body overflow kept.
- RoomFrame: `.stage-frame` > `.stage` with `.room-bg` / `.room-bg-open.is-visible`, `.room-tag`, `.scene-object[data-surface=desk]` (img width 100% height auto, ::after pill from data-label), `.scene-decoration`, `.door` + `.door-pill` (Locked / "Open the door →" / "Door opening…"). Locked + unavailable panels: `.modal-title` + `.t5-panel-state` + `.modal-note`. `.hint` under the stage. Held Dana desktop unchanged.
- Topbar: GameApp header -> `.topbar` / `.brand` / `.brand-mark` / `.eyebrow` / h2 (h1 is TeamLayout's). RoomFrame portals its toolbar (`.room-count` pill: name, 3 `.dot`s, "01"/"02"; Countdown pill) into a slot in the header.
- room-1.design.json: dana-login hotspot `assetId: login-screen`; labels from the design (idan "computer · SQL", hash "Hash Cracker"); door label "Open the door →"; title suffix "office" (room tag upper-cases it).
- game.css: design rules copied, scoped under `.team5-game` (all team CSS is global; App.css has .hint, team pages use .brand/.eyebrow); replaced t5- rules removed (t5-zoom*, t5-scene, t5-hotspot*, t5-door, t5-room-image*, t5-room-tag, t5-header, t5-brand, t5-eyebrow, t5-room-number, old toolbar row). Remaining t5 pieces (clock, account, status footer, leave row, buttons) recoloured to the design palette.
New names (R5): CSS classes are the design HTML's own. `toolbar` prop on RoomFrame = the header element the existing room toolbar (`.t5-room-toolbar`, kept as the slot's class) now renders into; no slot/portal exists today.

## Port B plan (Claude subagent, R1-R5)
Branch team5/port-B, worktree .claude/worktrees/portB. Files: game/screens/idan-sql/{IdanSqlScreen.tsx, idan-sql-screen.css, idan-sql-screen.test.tsx, sql-result.ts, sql-result.test.ts, sql-shell.ts, sql-shell.test.ts}; new vendor/xterm/{xterm.js, xterm.d.ts, addon-fit.js, addon-fit.d.ts, xterm.css, LICENSE}; vendor/README.md (one entry).
Design sources: design-code.html CSS 112-120 + mobile 438-441, xterm CSS 139-423, terminalOutput 1116, showTerminal 1143-1207; design.html L468/L470 (xterm UMD / FitAddon UMD, sourceMappingURL lines 469/471 dropped).
- vendor/xterm: byte copies of the design's xterm.js + addon-fit.js UMD bundles and xterm.css (MIT header), LICENSE; .d.ts declare the two globals the UMD sets when no module system is present (Terminal, FitAddon.FitAddon), only the members used.
- IdanSqlScreen -> design `.window-shell`: `.window-header` (`.window-back` "← Back to room" = close(), `.window-name` "⌘ Idan · SQL terminal", name from room-1.design.json characters), `.window-subtitle`, `.terminal-host` (xterm with the design's options/theme + FitAddon, fit on window resize, disposed on unmount), `.window-footer`. Old grid, Copy buttons, Run form and t5-sql-* CSS removed.
- sql-shell.ts (pure, no DOM): the design's line handling (Enter, Backspace, Ctrl+C, Up/Down history) + local commands (help, .tables, .schema from fixture room1-sql-v1.sql, clear); anything else -> runQuery(command), pending until a new latestResult commandId (or a submit error); refused with "Database starting…" until sandbox ready.
- sql-result.ts: add `formatSqlResult` (text table `a | b` + `-+-` separator, NULL, notice first, "(0 rows)", messages as lines) on top of readSqlResult.
- Adjustment: Escape is passed through xterm (attachCustomKeyEventHandler) so the panel's Esc close works while the terminal has focus (xterm cancels Escape otherwise).
Reused: PuzzleScreenProps, readSqlResult, submitErrorMessage, room1Design.characters, fakeViews. New names (R5): `SqlShell` (no terminal line-discipline exists), `formatSqlResult` (no text rendering of SqlOutcome exists), `sql-shell.ts`; CSS class names are the design's own.
- 05:07 Port C committed on team5/port-C = 38be40f (9 files, all slice C). tsc 0, strict 0, vitest 15 files 78/78, vite build ok, guard empty. Open: RoomFrame.test L62 queries exact 'Open room' (kept that aria-label); copyTextToClipboard now used only by IdanSqlScreen.
- 05:08 Port C reported done: 38be40f (9 files). Merge notes: aria 'Open room' kept (RoomFrame test); copyTextToClipboard may become dead after port B; double title until port A's ZoomPanel.
- 05:11 Port A committed on team5/port-A = 08a5e58. tsc 0, strict 0, vitest 15 files 77/77 (76 + 1 new modal-click test), standalone build ok, guard empty, 7 files (all Port A owned).
- 05:12 Port A reported done: 08a5e58 (7 files).
- Port A+C combined in worktree portX (served on :5174): tsc 0, strict 0, vitest 79/79. My first visual pass vs design (1280x960) found:
  D1 room: our door shows a "Locked" pill; design renders NO door in room 1 until Dana's desktop opens it.
  D2 device screens are ~10% wider than design: use design .interactive-screen width min(92vw, 950px, calc(74svh * 1.5)) now that the design modal is in.
  D3 behind the blurred modal a lighter band shows at far left/right (page background outside the game); design is dark everywhere.
- 05:15 D1-D3 fixed on team5/port-combined = 34d7242 (79/79, tsc 0, strict 0). Desktop now matches design size/position. Waiting for port B.
- Port B committed on team5/port-B = 92be4f0 (14 files, all team5). tsc 0, strict 0, vitest 16 files 88/88, guard empty. Changes vs plan: xterm loads lazily (dynamic import, own chunk); the build wraps the UMD as CommonJS (default export) while the dev server leaves it a plain script (globals), so the loader accepts both (checked by loading the built chunks and the dev-served files in jsdom). "SQL operation is not permitted." now prints as the database's own line (brief), not the blocked line (F1).
- 05:21 A+B+C combined on team5/port-combined=4ccfb14 (87/87, App 25/25, tsc 0, strict 0, build ok, madge 0). Captured 8 ours vs 8 design shots at 1280x960 in scratchpad/compare. Next: independent validators.
- Behaviour validator report received (see conversation): B1 closing held desktop opens room (design: close only hides; Dana hotspot reopens it; only .dana-file opens door); B2 focus can leave dialog (body focus after login swap / disabled pending); B3 hash draft not kept between openings (design deviceDrafts); B4 no transparent-pixel hit test on hotspots (design hitOpaquePixel L547-562, alpha<=28, keyboard exempt); B7 old login error reappears on reopen; B8 desktop pops up by itself if solve arrives after closing login panel / replaces other panel; B9 focus restore uses activeElement (no explicit trigger, no preventScroll); B10 room-count missing "/ 03"; B11 door delay 900 vs design 850; S1 focus outline on .modal-close/.window-back not in design; S2 .window-back font-weight/display; S3 .hint margins; S4 letter-spacing:0 overrides xterm rows; S5 room-count text "Dana's room" (literal). Kept as intended: server-side non-SELECT handling, sql> prompt + intro (real engine is PostgreSQL), locked states, aria "Zoom:" prefix not added.
- Visual validator report received: V1 header inset ~34 CSS px each side (design .app padding 18px, topbar min(100%,1400px)); V2 SQL subtitle/footer must be right-aligned; V3 page content 10 CSS px lower; V4 hint needs ~13 CSS px more above; V5 page taller than viewport (TeamLayout chrome above + status rows); V6 desktop monitor bezel rim (asset resample, accept). Everything else verified matching within 1px.

## Fix round plan (Claude subagent, R1-R5)
Branch team5/port-combined (worktree portX, from 4ccfb14). Files: Team5Page.tsx; game/{RoomFrame.tsx, RoomFrame.test.tsx, ZoomPanel.tsx, GameApp.test.tsx, game.css}; game/screens/hash-cracker/{HashCrackerScreen.tsx, test}; game/screens/dana-login/{DanaLoginScreen.tsx, test}; game/screens/idan-sql/{idan-sql-screen.css, IdanSqlScreen.tsx, sql-shell.ts, tests}.
- RoomFrame: desktop shown only while the Dana panel is the active one (B8); ×/Esc/outside = hide (closePuzzle), only the .dana-file = openRoom (B1); held latch not re-set by a later move once the solve was seen; last room-1 puzzle list kept in a ref for hotspots during the hold/door (B1); hotspot click stores the trigger (B9) and ignores transparent pixels for mouse clicks (design hitOpaquePixel, cached per src, allowed when canvas/size unavailable) (B4); room pill "Dana's room" / "Coming soon", "01 / 03" (B10); door delay 850 (B11); inputs to a puzzle no longer in the view are not sent.
- ZoomPanel: `trigger` ref prop restored with preventScroll (B9); `screen` prop refocuses .modal-content when it changes (B2); Tab with focus outside the dialog -> first control (B2).
- Hash: module Map of drafts per session (B3). Dana login: rejection present at open not shown (B7).
- CSS: S1 (:where exclusion), S2, S4 (.xterm-rows * inherit), V2, V1/V3/V5 (productView + design .app padding/gap, team5-scoped dev-chrome styles), V4 (hint margin 1em + gap 13).
- Daniel addition: SQL terminal named after PostgreSQL: prompt `puzzle=> `, intro, subtitle; local `\dt`, `\d`, `\d <table>`, help, clear (no .tables/.schema).
New names (R5): ZoomPanel `trigger`/`screen` props (no existing way to pass the opener or a screen change); `hitOpaquePixel` (design's name); `hashDrafts` (design deviceDrafts); `rejectionAtOpen`; `lastRoom1Puzzles`.
- 05:43 Fix round committed on team5/port-combined = 9d6026f (16 files, team5 only). tsc 0, strict 0, vitest 16 files 93/93, App 25/25, standalone build ok, madge 0, guard empty.
- 05:48 Demo GIFs recorded via Claude in Chrome on :5174 (fix-round code 9d6026f): ~/Downloads/skillbreak-room1-part1-sql.gif (38 frames), ~/Downloads/skillbreak-room1-part2-hash-dana.gif (35 frames). Demo account demo_player (local). Full Room 1 flow passed live incl. psql naming, blocked UPDATE, wrong hash, wrong password, desktop, room 2.
- 05:50 DESIGN PORT MERGED ff room1-demo=6da6ded (ports A,B,C + fix rounds; 93/93, App 25/25, tsc 0, strict 0, build ok, madge 0, team5 only). Round-2 review: no high-severity gaps, no regressions. Kept: page height (status + Leave rows below hint), drag guard, LTR focus order, clear;.
- 05:56 Copied back to Dropbox (Daniel OK): rsync -a --exclude node_modules --exclude .DS_Store, no --delete. FE room1-demo=6da6ded, BE main=bcef9ff; re-check shows 0 differences. SLICE-CLAIMS.md and QA-room1.md copied to the Dropbox SkillBreak folder.
- 06:06 SQL view MERGED ff room1-demo=4b5a709: DESIGN-v2 command box + result grid (F1 centre, Copy per cell) inside the design HTML window-shell (header, Back to room, PostgreSQL subtitle, footer, modal x). Removed vendored xterm + sql-shell (DESIGN-v2: xterm is for the git terminal). Clean checkout: 111/111 (team5 86 + App 25), tsc 0, strict 0, build ok, madge 0, guard empty. Browser: rows, blocked UPDATE, Esc + focus restore OK.
- 06:13 Click-to-copy MERGED ff room1-demo=2bc7074: SQL cell values and the cracked password copy on click via shared copyShownValue (no Copy buttons; selection-drag doesn't copy; clipboard blocked -> value selected). Clean checkout 114/114 (team5 89 + App 25), tsc 0, strict 0, build ok, madge 0.
- 06:15 room1-demo=0e9d52e: removed the SQL box placeholder (hint) per Daniel.
- 06:17 Copied back to Dropbox again: FE room1-demo=0e9d52e.
- 06:25 Demo video (partial run, stopped by Daniel after the hash paste) saved to Dropbox SkillBreak/skillbreak-room1-demo.mov. Code already merged (room1-demo=0e9d52e) and copied back.
- 06:47 Demo video: SkillBreak/skillbreak-room1-demo.mp4 (46 s, 1600x1032, page only, 1Password off, browser save-password pop-up patched out, still time capped at 0.35 s). Full run sign-up -> room 2. No code changes.
