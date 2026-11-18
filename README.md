# GitHub Core Clone — a standalone git forge

![Competition](https://make.fun/badge/github-core-clone-01.svg)
![Rank](https://make.fun/badge/github-core-clone-01/bangandrii/github-core-clone/rank.svg)
![Reward](https://make.fun/badge/github-core-clone-01/bangandrii/github-core-clone/reward.svg)

A from-scratch, single-process GitHub-compatible forge built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).
It speaks git smart HTTP, the GitHub REST API v3, GraphQL v4, and MCP — all
backed by its own in-memory object store. No git binary, no database, no
dependencies beyond the Node.js standard library.

## What it implements

- **Git smart HTTP** — protocol v2 (ls-refs with symrefs and peeled tags,
  fetch with shallow/deepen and have negotiation) and v0 fallback;
  receive-pack with report-status, fast-forward enforcement, annotated tags,
  and full pack build/parse including delta application.
- **REST v3** under `/api/v3` — repositories, branches, refs, commits,
  contents, labels, issues, pull requests (diff files with real line counts,
  three-way squash merge), pagination and GitHub-shaped errors.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues and pull
  requests with cursor pagination, `node(id:)` round-trips, search,
  introspection, and the createIssue / closeIssue / addComment /
  createPullRequest / mergePullRequest mutations.
- **MCP** at `/mcp` — JSON-RPC with `server/discover`, initialize, and six
  tools (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request) sharing the same store as REST.

Local verification against the bounty suite: **120/120 checks, 979/1000**
(feature 600/600, agent 200/200, performance 179/200).

## Running

The entry point is `main.ts`, started by the make.fun environment with
`node --experimental-strip-types main.ts`. It binds an ephemeral port,
registers it with `$MAKEFUN_ENV_URL`, and serves until the environment
signals completion.

## License

MIT — see `LICENSE`.
