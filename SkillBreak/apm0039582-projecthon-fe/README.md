# projecthon-fe

Gateway frontend for the projecthon team microservices (dev environment).

- Basic Vite + React + TypeScript SPA.
- A dedicated page per team, served at `/team1` … `/team7`.
- Deploys to the shared `tdp-2026` namespace so the ingress can route to the
  `projecthon-team1` … `projecthon-team7` backend services.

## Routing (dev)

Host: `projecthon.dev.att.com`

| Path | Served by |
|---|---|
| `/` | SPA home page (team index) |
| `/team1` … `/team7` | SPA team pages |
| `/api/team1/*` … `/api/team7/*` | `projecthon-team1` … `projecthon-team7` |

The SPA routes and the backend routes are deliberately kept on separate prefixes:
the frontend owns `/teamN`, while the backends are mounted under `/api/teamN`.
A second Ingress with an nginx `rewrite-target` strips the `/api/teamN` prefix
before forwarding, so each backend receives a clean path.

Client-side routing uses the History API, and nginx falls back to `index.html`
for unknown paths, so deep links such as `/team3` load correctly.

## Team ownership

Each team owns its own directory — no shared file to merge-conflict over:

```
src/
  teams.ts              # team registry (routes + api paths)
  api/teamApi.ts        # fetch helper for /api/<team>
  pages/                # home + not-found
  teams/
    registry.ts         # maps team id -> page component
    TeamLayout.tsx      # shared chrome + backend status
    useTeamBackend.ts   # hook calling the team's backend
    team1/Team1Page.tsx # <- team 1 works only in here
    ...
    team7/Team7Page.tsx # <- team 7 works only in here
```

Each `TeamNPage` renders inside `TeamLayout`, which calls that team's backend
through `apiPath` and shows the connection status plus the raw response.
Teams add their own UI as children.

## Scripts

```bash
npm install
npm run dev      # local dev server
npm run build    # production build -> dist/
npm run test     # vitest + coverage
```
