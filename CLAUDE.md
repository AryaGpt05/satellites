# Notes for Claude Code sessions

## Commits

- Author every commit as the owner: `dev-Armaan <134523744+dev-Armaan@users.noreply.github.com>`
  (`git config user.name "dev-Armaan"` and `git config user.email "134523744+dev-Armaan@users.noreply.github.com"`
  in each fresh clone, before the first commit). Claude goes in a `Co-Authored-By:` trailer, never as the author.
- `integration` is the working branch; a push to `main` deploys production. The catalog bot commits to `main`, so
  merge `origin/main` into `integration` before pushing `main`.
