---
name: team-jira-workflow
description: "SkillBreak team rules for any Jira work in LUTDP: create, update, comment, transition, or link pull requests. Applies the Projecthon Jira workflow. Use together with jira-manager for every Jira task."
---

# SkillBreak Jira workflow

These rules apply the Projecthon Jira workflow to the SkillBreak team.

Use the [jira-manager skill](../../../.agents/skills/jira-manager/SKILL.md) for the API calls; this skill decides what may be changed and how.

## Team values

| Item | Value |
|---|---|
| Project | `LUTDP` (shared with other teams) |
| Team Features | `LUTDP-6` "SkillBreak" + any additional SkillBreak Feature keys |
| Label | `skillbreak` |
| Summary prefix | `[SkillBreak] ` |
| Credentials | Each user's own `~/.levelup`; never committed |

## Safety rules

1. Only read or change tickets belonging to SkillBreak Features listed in this file, their Stories, and their Sub-Tasks. Never change other teams' tickets. Check the parent chain before any write.
2. Before any write (create, update, comment, transition, link), show the exact list of changes and wait for the user's explicit approval.
3. Before creating, search the parent's children (`parent = KEY`) and skip summaries that already exist.
4. Never ask for, paste, print, or commit the API token. If authentication fails, tell the user to check `~/.levelup`; `JIRA_URL` must be the site root only.
5. Summarize and link repository-relative paths instead of copying design content into Jira. No employee data in tickets or logs.
6. Change repository files through a branch and pull request; never commit credentials.

## Ticket structure

SkillBreak uses Option B:

- Create a separate Feature for each product feature.
- Every SkillBreak Feature must have the label `skillbreak`.
- Stories are created under the matching SkillBreak Feature.
- Break each Story into Sub-Tasks for the concrete work.
- Put new work under the matching existing Story when appropriate.
- The safety scope includes every SkillBreak Feature key listed in this file.

Current SkillBreak Features:
- `LUTDP-6` - `SkillBreak`
- Add additional SkillBreak Feature keys here as they are created.

## Naming and labels

- Every Story and Sub-Task summary starts with `[SkillBreak] `.
- Sub-Tasks name the area next, for example `[SkillBreak] <Area>: <task>`.
- Every SkillBreak Feature, Story, and Sub-Task has the label `skillbreak`.
- Required fields: a Story needs a `description` (Cloud v3 ADF); a Sub-Task needs a `parent`.
- Add Story Points as estimated days (0.5 to 4). Split anything larger than 4 days into smaller tasks.

## Status

- Move a Story or Sub-Task to **In Progress** when work begins.
- Move it to the team's done status when the work is done.
- Find the transition id with `GET /rest/api/3/issue/{KEY}/transitions`.
- Never use Deleted.
- Keep statuses current. When a pull request merges, propose moving its ticket to the team's done status.

## Pull requests

- Link every pull request to the ticket that describes its work, usually a Sub-Task. The ticket must be specific enough to explain what the pull request changes.
- Start the pull request title and commit messages with the key, for example `<KEY>: <short description>`, and link the ticket in the pull request description.
- If the Development panel stays empty (repository not connected to GitHub for Atlassian), add the pull request as a web link (with approval):

POST /rest/api/3/issue/{KEY}/remotelink

{"globalId":"github-pr:<org>/<repo>/<n>","object":{"url":"<pull request URL>","title":"PR #<n>: <title>"}}

## Setup for a teammate

1. Pull `main` and reload VS Code.
2. Create `~/.levelup` with `chmod 600`, containing `JIRA_URL` (site root), `JIRA_USER_EMAIL`, and `JIRA_TOKEN` (your own Atlassian API token).
3. Test with a read using one of the SkillBreak Feature keys.
