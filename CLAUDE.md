# Peer: notes for coding agents

- Product rules: `PEER.md`. Architecture: `docs/architecture.md`.
- **Definition of done.** An implementation task is ready for the developer only after the independent verification loop in `.claude/skills/verify-peer/SKILL.md` (`npm run verify:peer`). Your own summary is not evidence. See `docs/verification.md`.
- Never commit, push or merge unless the developer asks.
- Real-model runs spend the developer's quota. `npm run verify:modes`, `npm run validate:collab` and `npm run eval:integration -- --confirm` need an explicit `--model`. Run them only when asked.
- Script flags go after `--` (`npm run x -- --flag value`). Peer's scripts reject flags that npm consumed.
