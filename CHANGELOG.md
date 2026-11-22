# Changelog

Releases are `vX.Y.Z` tags (see `AGENTS.md`). Every push to `dev` also publishes `edge` and `build-N` images.

## [v1.0.0] - 2026-11-22

First tagged release.

- Online games vs friends (invite link), Stockfish or external bots, refereed by the bot API server
- Local analysis board, multi-threaded Stockfish analysis, eval bar
- Accounts with synced settings and saved games; PGN/FEN/JSON import and export
- Bot API and MCP server (HTTP and stdio), including user vs Stockfish with Claude spectating
- Multi-arch Docker images on Docker Hub (`darknetz/chess`, `darknetz/chess-bot`) and GHCR (`ghcr.io/darknetzz/chess`, `ghcr.io/darknetzz/chess-bot`), built by GitLab CI
