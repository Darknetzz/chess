# Agent notes

- **Version line:** `version.json` is tracked and rewritten by `.githooks/pre-commit` (build = commit count, + date). Don't edit it by hand. Enable the hook once per clone: `git config core.hooksPath .githooks`. Needed because the docker02 deploy (Arcane git-sync) has no `.git`, so the version can't be derived at build time.
- Don't `git commit --amend` or rebase after a commit: the build number would drift.
