# Quickstart: Room 2 Demo and Winning-Path Verification

## Status and scope

This guide runs the whole game locally, from Room 1 through Room 2 to the victory screen, and lists the tests that prove the same path in CI. Room 2 is catalog script v5 (gameplay catalog 4 plus the Room 2 content). All values below come from the generated scenario (`room2-scenario.generated.ts`); they are synthetic puzzle material, not real credentials.

Run commands from the repository root of the backend. The frontend is the Team 5 slice of the shared frontend repository.

## 1. Prerequisites

- Node.js 22 and `npm ci` at the backend root; Docker (Compose) for the two PostgreSQL databases.
- `.env` created from `.env.example` (see Configure in the [README](../../README.md)), including `INTERNAL_API_TOKEN`. For the browser, set `CORS_ORIGINS` to the frontend origin, for example `http://localhost:5173`.
- Frontend: `npm ci` in the frontend repository.
- Use a path without spaces for the backend checkout.

Room 2's git puzzle is embedded-only (ADR 0001, [embedded sandbox driver](../adr/0001-embedded-sandbox-driver.md)): its repository runs inside the engine process in every mode. Use the default `embedded` mode; no container, kind cluster or git image build is needed.

## 2. Run the backend and publish v5

```sh
sh scripts/demo-room1.sh
```

With the default `SANDBOX_DRIVER=embedded` the script builds the foundation packages and the local runtime, starts `postgres` and `engine-db`, runs both migrations, then publishes in order: the Room 1 content (`seed:room1`), the SQL template 2 pinned to the embedded fixture (`seed:room1:sql --embedded`), gameplay catalog 4 (`seed:gameplay`), and the Room 2 content as script v5 (`seed:room2`). Finally it starts the gateway (:3000) and engine (:3001) in one process and logs to `room1-trail.log`.

Optional: where the corporate npm registry is unreachable from Docker builds, point Compose at a public registry configuration, for example `COMPOSE_FILE="docker-compose.yml:<dir>/override-room2.yml" NPM_USER_CONFIG="<dir>/public.npmrc" sh scripts/demo-room1.sh`, where the override and `.npmrc` are local files you create for your machine. Do not commit them.

If the Room 2 content changes, regenerate it with `npm run room2:generate` and check it with `npm run room2:verify`.

## 3. Run the frontend

```sh
node_modules/.bin/vite --config src/teams/team5/vite.local.config.ts --port 5173
```

Open `http://localhost:5173/src/teams/team5/standalone/index.html`.

## 4. Walk-through

Room 1

1. Start the game. On Idan's database, run `SELECT l.password_hash FROM logs l JOIN employees e ON e.id = l.employee_id WHERE e.username = 'danaZ22' AND l.password_hash IS NOT NULL`. This solves `idan-db`.
2. Open the hash cracker and submit that hash. It reveals the password and solves `hash-cracker`.
3. On Dana's computer log in with `danaZ22` / `edenIsMyFavourite` (solves `dana-login`), then click "Open room" on Dana's desktop (OpenDoor `room-1`), then "Enter Room 2" (EnterRoom).

Room 2

4. Open the git terminal on Nathanel's computer. Run `git log --oneline`: five commits, the top one is "Security fix: Removed private key from repository.".
5. Run `vim server.key`: "Command not allowed" (editors are blocked).
6. Ruin and reset: run `git commit --allow-empty -m oops`. The repository is ruined, the sandbox is replaced (generation 1 to 2), the history is pristine again, and the game continues with the same clock. This is expected, not a failure.
7. Run `git show HEAD~1:server.key`. The PEM private key prints; `nethanel-git` is solved and the RSA decryptor opens.
8. Open the capture viewer (Nathanel's computer, `Cibus_payment_try.pcap`). Frame 1 shows the Client Random, frame 3 the certificate Modulus (N), frame 5 the RSA Encrypted PreMaster Secret.
9. RSA decryptor: paste the private key, N and the encrypted PMS. The output is the PreMaster Secret (96 hex characters, starting `0303`). This solves it and opens the TLS decryptor.
10. TLS decryptor: enter the PMS and the Client Random. "The file has been decrypted" appears and the door puzzle opens. The capture now shows the decrypted `POST /api/v2/payments`, including `card_number` `4000000131941181`.
11. Exit keypad: a wrong code shows ACCESS DENIED; `4000000131941181` shows ACCESS GRANTED. Click "Open door" (OpenDoor `room-2`), then click the "To the victory room" pill on the door (EnterRoom).
12. The victory screen appears (status Escaped). A reload keeps it, and all rows in `sandbox_instances` for the session end `destroyed`.

## 5. Troubleshooting

- Git needs the embedded driver (ADR 0001). With `SANDBOX_DRIVER=kubernetes` the SQL puzzle runs on kind but Room 2's git still runs embedded; there is no kubernetes git image.
- Esc does not close the xterm terminal window. Use the back button or the x in the window header.
- The keypad sits over the middle of the open door; click the "To the victory room" pill, not the door centre.
- The terminal says the sandbox is restarting after a ruin: wait a second; the new generation is provisioning. Commands for the old generation are refused by design.
- A puzzle stays locked: check that script v5 is published (`seed:room2`) and that you re-started the session after publishing. Sessions started before a publish keep their version.
- Gateway CORS errors in the browser: `CORS_ORIGINS` must contain the frontend origin.

## 6. Tests

Backend (from `apps/game-engine`):

```sh
npx jest --config jest.config.cjs test/room2-winning-path.test.ts   # whole game, no database
npx jest --config jest.config.cjs                                   # full default run
npx tsc -p tsconfig.test.json --noEmit
npm run test:room2:git:integration                                  # gated; disposable PostgreSQL in Docker, full path to Escaped
```

`room2-winning-path.test.ts` replays Start to Escaped on the real v5 content with the real transition, component factory, embedded SQL and git sandboxes and the crypto worker pool, including the git ruin and reset. It also asserts the card number never appears before the TLS solve and the private key appears only in the git output.

Frontend (from the frontend repository):

```sh
npx vitest run src/teams/team5
npx tsc -p src/teams/team5/tsconfig.json --noEmit
```

`room2-flow.test.tsx` renders the registered Room 2 screens in order with fake views.
