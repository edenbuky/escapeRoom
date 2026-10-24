# Design Technologies

Binding architectural constitution for this project. Every feature is built inside these constraints. A later design choice that drops one of them is a change to this document, not a local exception.

## System shape

The product is a browser application backed by a server. The browser never owns business rules. The server never renders the UI.

```text
React UI  --REST-->  NestJS (TypeScript)  --TypeORM-->  Postgres
                           |
                           +-- Entra ID     (sign-in)
                           +-- Swagger UI   (OpenAPI)
                           +-- Redis        (exactly one cached feature)
                           +-- event bus    (exactly one EDA feature)
```

## 1. Backend server

The backend is a NestJS application written in TypeScript. It exposes a REST API and owns all business logic.

- TypeScript is the only language in this codebase. The server runs on Node.js through NestJS. Java and the JDK are not used.
- Clients talk to resources over HTTP with JSON.
- Validation, state changes, and domain rules run in NestJS.
- The API is the only way the frontend reads or changes application state.
- The API is described with OpenAPI and published through Swagger UI (`@nestjs/swagger`). Swagger UI is the interactive documentation for every endpoint.

## 2. Frontend app

The frontend is a React application written in TypeScript. It communicates with the backend only through the REST API.

- No business rules live only in the browser. The UI may present state and collect input; the server decides whether an action is allowed and what it does.
- The frontend does not open Postgres, Redis, or the event bus directly.

## 3. Authentication

Sign-in is Microsoft Entra ID. The session is an Entra-issued token, not a server-side session cookie, and not a password the application checks itself.

- The browser sends the user to Entra ID. Entra ID authenticates them and issues a token.
- Later requests send that token. The NestJS server validates it against Entra ID and accepts or rejects the call from the token.
- The application does not collect, hash, or store passwords. Creating the account is an Entra ID concern.

## 4. Authorization

Access is role-based. An action is allowed only when the actor's role permits it.

- Every protected action names the role that may perform it.
- The server enforces the check. Hiding a button in the UI is not authorization.
- A missing or insufficient role is rejected by the API.

## 5. Database

The system database is Postgres. Application data that must survive a restart is stored there, and NestJS reads and writes it only through TypeORM.

- Users, roles, and domain records are TypeORM entities mapped to Postgres tables. A user row stores the Entra ID identity. It does not store a password.
- NestJS reads the Postgres connection from environment variables. Locally those variables come from `.env`. `.env.example` lists every required variable with a placeholder. The real `.env` stays out of version control, and no real secret is committed.
- TypeORM migrations create and update the schema. The same documented command rebuilds a clean local database.
- An in-memory store or a mocked repository is not a substitute for the system database. A write made through the API is still there after the server restarts.
- The riddle SQLite prop below is not a TypeORM database. Postgres remains the system database.

## 6. Caching

Redis is used for caching, and it is used in exactly one feature.

- That feature reads through Redis and still treats Postgres as the source of truth.
- Other features do not add a second cache "while we are here."
- The feature that owns the cache is named here once it is chosen:

  | Obligation | Feature | Status |
  | --- | --- | --- |
  | Redis cache | Admin statistics: read-heavy aggregates for `GET /admin/stats`; Postgres is the source of truth; the cache is cleared when a session ends | chosen |

## 7. Event-driven architecture

Exactly one feature is implemented with event-driven architecture.

- That feature publishes a domain event when something happens, and a separate handler reacts to the event. The caller does not perform the downstream work inline.
- Other features stay request/response. They do not grow their own event flows.
- The feature that owns EDA is named here once it is chosen:

  | Obligation | Feature | Status |
  | --- | --- | --- |
  | EDA | Hint platform: earned notes on riddle solved | chosen |

## First riddle

Iden's computer uses sqlplay for the SQL screen. sqlplay is the library that supplies both the small SQLite database and the console UI: the table list, the SQL input, and the result view underneath. The riddle tables, `employees` and `logs`, are loaded with sqlplay's server init, and the console is mounted read-only so the player can run `SELECT` only.

That SQLite database is the riddle prop. Postgres remains the system database.

The Hash-Cracker does not reverse the hash. The NestJS server builds it with Node.js `crypto` and stores the hex in `logs`. When the player submits a hash, the server compares it to that value and, on a match, returns Dana's password.

```typescript
import { createHash } from 'node:crypto';

const hash = createHash('sha256').update(password, 'utf8').digest('hex');
```

## Second riddle

Nethanel's terminal uses xterm.js (`@xterm/xterm`) for the black screen. It draws the prompt, the cursor, and the scrollback. The player types a line, and the text stays on the screen. xterm.js does not run git and does not hold a repository. When the player presses Enter, the line is sent to the server. The server returns text, and the screen prints it with `term.write()`.

The repository is isomorphic-git on the NestJS server. At startup the server builds an in-memory repository with two commits. The first commit adds the private key. The second commit removes it, with the message "Security fix: Removed private key from repository." When the terminal sends a line, the server calls isomorphic-git and returns text. `git log` returns the two commit messages. `git show` on the previous commit returns the private key. isomorphic-git does not draw the screen and does not open a shell. It reads the repository and returns the content.

That repository is the riddle prop. Postgres remains the system database.

## What this document does not decide

The rest of the story and the screens are still open, as is which single feature receives Redis or EDA. Those choices get written back into the tables above. They do not replace the seven constraints.
