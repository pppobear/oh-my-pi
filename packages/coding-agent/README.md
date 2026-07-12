# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `oh-my-pi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

The agent supports five mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.
- `mnemopi` — stores and searches scoped long-term memory in a local SQLite database, with `memory_edit`, `retain`, `recall`, and `reflect` tools.
- `openviking` — talks to an OpenViking server, captures session turns, refreshes recalled context before each agent turn, exposes `retain`, `recall`, and `reflect`, and reads OpenViking resources through `memory://`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

### OpenViking quickstart

1. Start an OpenViking server or configure the official CLI in `~/.openviking/ovcli.conf`.
2. Set `memory.backend = "openviking"`. The agent discovers the server URL and matching credentials from `ovcli.conf`; explicit `openviking.*` settings take precedence.
3. Optional environment overrides (env wins over settings):
   - `OPENVIKING_URL`, `OPENVIKING_BEARER_TOKEN` or `OPENVIKING_API_KEY` — connection; `OPENVIKING_CREDENTIAL_SOURCE=cli` forces the official CLI profile
   - `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`, `OPENVIKING_PEER_ID`, `OPENVIKING_WORKSPACE_PEER` — tenant and workspace identity
   - `OPENVIKING_RECALL_PEER_SCOPE` — `actor` (default) recalls global plus current-project memory; `all` also includes penalized memories from other projects
   - `OPENVIKING_AUTO_RECALL`, `OPENVIKING_AUTO_CAPTURE`, `OPENVIKING_RECALL_LIMIT` — lifecycle and recall

By default, OpenViking recall and capture use a collision-resistant peer derived from the current workspace, keeping project memories isolated while retaining access to global memories. Set `openviking.recallPeerScope` to `all` for cross-project recall, set `openviking.peerId` to override the derived peer, or disable `openviking.workspacePeer` to use the server's unscoped default; each setting also has the environment override listed above.

OpenViking archives new session messages synchronously and extracts durable memories asynchronously. Explicit `retain` and `learn` calls wait for extraction up to the configured bound, while automatic capture tracks extraction in the background.

OpenViking does not support `/memory clear` or `/memory reset`; delete server-side resources by URI instead. See [Autonomous Memory](../../docs/memory.md) for the command contract.

Changing `memory.backend` or an `openviking.*` setting in the interactive Settings panel takes effect for parent and subagent sessions before the next prompt or `/memory` operation. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.
