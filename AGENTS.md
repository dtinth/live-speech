# live-speech

Live captioning for local tech talks, built for Thai speech mixed with English technical terms. Rewritten from scratch in 2026 (spec: GitHub issue #2); issues about the 2024 version do not apply to this code.

## Commands

Bun is pinned in `mise.toml`.

- `bun test` runs all tests (no network, no credentials).
- `bun run typecheck` type-checks.
- `bun run dev` starts the server with hot reload on `PORT` (default 3000). It reads `.env`; see `.env.example`.
- `docker build .` builds the deployable image (`EXPOSE 3000`, `VOLUME /data`).

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `dtinth/live-speech`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
