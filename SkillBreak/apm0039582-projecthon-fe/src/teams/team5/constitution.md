# Team 5 Constitution

Version: 1.0.0

Ratified: 2026-11-01

Scope: `src/teams/team5/`

## Principles

### 1. Respect the Team 5 ownership boundary

Team 5 changes belong in this directory. Do not edit files outside it as part of Team 5 work unless the user explicitly authorizes expanding the scope.

### 2. Preserve the shared page integration

`Team5Page` must accept its typed `team` and `onNavigate` props and render its page content inside `TeamLayout`. Add Team 5 UI as children of that layout rather than replacing or bypassing the shared shell.

### 3. Keep the TypeScript contract explicit

Use the existing `Props` contract and typed React components. Preserve the `TeamService` type and the `(to: string) => void` navigation callback; do not weaken these contracts to accommodate UI changes.

### 4. Keep changes focused

Implement Team 5-specific behavior in this directory and avoid unrelated changes. Preserve the existing default export from `index.ts` so the Team 5 page remains exposed through its current entry point.

## Change review

Review changes against these principles before completion. If a necessary change cannot comply with the ownership boundary or shared integration contract, request authorization before expanding scope.
