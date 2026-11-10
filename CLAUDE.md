# Notes for Claude Code sessions

## Commits

- The owner is the **author** of every commit; Claude stays the **committer**. In each fresh clone, before the first
  commit:
  `git config author.name "dev-Armaan"` and `git config author.email "134523744+dev-Armaan@users.noreply.github.com"`.
  Leave `user.name` / `user.email` as the session set them (Claude): the session signs commits with Claude's key, and
  GitHub shows a commit as Verified only when the signing key belongs to the committer. Making the owner the committer
  too turns every commit Unverified (reason `unknown_key`). Claude also goes in a `Co-Authored-By:` trailer.
- Split work into many small commits, one per self-contained change (a fix, a feature's layer, its tests, its docs),
  each building and passing tests on its own, rather than one combined commit. Follow-up fixes get their own commits.
- `integration` is the working branch; a push to `main` deploys production. The catalog bot commits to `main`, so
  merge `origin/main` into `integration` before pushing `main`.
