# Agent notes

- **Version line:** `version.json` is tracked and rewritten by `.githooks/pre-commit` (build = commit count, + date). Don't edit it by hand. Enable the hook once per clone: `git config core.hooksPath .githooks`. Needed because the docker02 deploy (Arcane git-sync) has no `.git`, so the version can't be derived at build time.
- Don't `git commit --amend` or rebase after a commit: the build number would drift.

## Repos

- `origin` = GitLab `gitlab.kriss.li/kriss/chess` (CI runs here). `github` = `Darknetzz/chess`, pushed by hand (no mirror). Do **not** add GitHub Actions; all CI is `.gitlab-ci.yml`.

## Docker images and releases

GitLab CI builds `linux/amd64` + `linux/arm64` images of the web app (`Dockerfile`) and the bot service (`bot/Dockerfile`) and pushes them to Docker Hub `darknetz/chess`, `darknetz/chess-bot` and GHCR `ghcr.io/darknetzz/chess`, `ghcr.io/darknetzz/chess-bot`:

- every push to `dev`: `edge` and `build-N` (N from `version.json`);
- `vX.Y.Z` tags: `X.Y.Z`, `X.Y`, `X`, `latest`, plus a GitLab release from the `CHANGELOG.md` section.

Release: add a `## [vX.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` (leave it uncommitted), then `scripts/release.sh X.Y.Z --dry-run` and `scripts/release.sh X.Y.Z`. It lints, commits "Release vX.Y.Z", tags, pushes `dev` + tag to GitLab and GitHub, and creates the GitHub release with `gh`.

CI variables on the GitLab project: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `GHCR_USERNAME`, `GHCR_TOKEN` (GitHub classic PAT, `write:packages`). Tokens are masked + protected, so `dev` and `v*` tags are protected refs. Without any token the `docker` job is skipped. Needs a privileged runner (docker:dind).
