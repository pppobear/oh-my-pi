# retain

> Store durable facts through the active long-term memory backend.

## Source
- Entry: `packages/coding-agent/src/tools/memory-retain.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — per-session queue, flush, auto-retain.
  - `packages/coding-agent/src/hindsight/backend.ts` — session bootstrap, prompt injection, subagent aliasing.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id derivation, tag scoping, first-use bank/mission setup.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` calls.
  - `packages/coding-agent/src/hindsight/content.ts` — retention transcript shaping, memory-tag stripping.
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank-scoped mental-model seeding and cache rendering.
  - `packages/coding-agent/src/hindsight/seeds.json` — built-in mental-model seed definitions.
  - `packages/coding-agent/src/hindsight/transcript.ts` — extracts user/assistant turns for auto-retain.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/backend.ts` — local backend bootstrap, prompt injection, subagent aliasing, enqueue/clear.
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped recall/retain state and local writes.
  - `packages/coding-agent/src/mnemopi/config.ts` — local SQLite path, bank, scoping, provider settings.
  - `packages/mnemopi/src/core/memory.ts` — local memory runtime used by `remember(...)`.
- OpenViking collaborators:
  - `packages/coding-agent/src/openviking/state.ts` — transcript archival boundaries, extraction task monitoring, and persisted capture cursors.
  - `packages/coding-agent/src/openviking/client.ts` — session messages, two-phase commits, task-list reconciliation, and extraction task polling.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | Yes | One or more memories to store. `minItems: 1`. Each item must be self-contained; `context` is optional per-item provenance. |

## Outputs
The output depends on the active `memory.backend`.

Hindsight:
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` or `"<count> memories queued."`
- `details = { count: number }`
- The write is not confirmed before the tool returns. The queue flushes later; flush failures emit a session warning notice and are not returned to the model.

Mnemopi:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."`
- `details = { count: number }`
- The tool calls the local backend synchronously, but `rememberScoped(...)` catches per-item write failures and returns `undefined`; the tool still reports the requested count.

OpenViking:
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."` when extraction completes within the bounded wait and creates durable memories. This count comes from the extraction task and can differ from the input item count.
- A completed task that extracts zero durable memories reports `0 memories stored; OpenViking completed extraction without creating a durable memory.` instead of claiming the requested items were stored.
- `content[0].text = "<count> memory queued for extraction."` or `"<count> memories queued for extraction."` when synchronous archival succeeds but the extraction task does not finish within that wait.
- If archival succeeds but task status is unavailable or the status check is interrupted, the response says the memory inputs were archived and that extraction status is unavailable/interrupted; it does not call them queued or stored.
- If neither the message write nor the follow-up archive can be acknowledged, the response says automatic reconciliation remains pending and warns against retrying the full batch yet.
- Before Phase 1, the client persists the current commit-task IDs. If the commit response is lost, it adopts only one unambiguous new task; zero or multiple new tasks remain reconciling and the input is not sent again.
- Task-delta recovery assumes one writer per OpenViking session. If no task appears, persisted `commit_count` advancement can confirm an untracked archive without claiming extraction. With neither a task nor Phase 1 evidence after the recovery window, the state remains blocked for manual OpenViking inspection because the current commit API has no idempotency key.
- A failed extraction task is returned as a tool error; archival success alone is not reported as stored.

## Flow
1. `MemoryRetainTool.createIf(...)` exposes the tool when `memory.backend` is `"hindsight"`, `"mnemopi"`, or `"openviking"`.
2. `execute(...)` re-reads `memory.backend` and dispatches to the matching session state.
3. If the backend is `mnemopi`:
   - it fetches `session.getMnemopiSessionState()` and throws if the backend was not started;
   - for each item, it calls `state.rememberScoped(item.content, ...)` with `source: "coding-agent-retain"`, `importance: 0.75`, `scope: "bank"`, `extract: true`, `extractEntities: true`, `veracity: "tool"`, `memoryType: "fact"`, and metadata `{ session_id, cwd, context, tool: "retain" }`;
   - writes go to the scoped retain bank selected by `packages/coding-agent/src/mnemopi/config.ts`.
4. If the backend is `openviking`, the items are added to the active parent session and committed in two phases:
   - before sending the commit, the state records a task-list baseline and the exact transcript boundary in its capture cursor;
   - Phase 1 synchronously archives the new session messages and returns an extraction task id;
   - Phase 2 extracts durable memories asynchronously, and the explicit tool call polls that task for a bounded time;
   - completion reports the server's extracted-memory count (including an explicit zero-memory outcome), a timeout reports the input items as queued for extraction, and task failure throws.
5. If the backend is `hindsight`:
   - it fetches `session.getHindsightSessionState()` and throws if the backend was not started;
   - each input item is handed to `HindsightSessionState.enqueueRetain(...)`;
   - `HindsightRetainQueue.enqueue(...)` appends the item and either flushes immediately when the queue reaches `RETAIN_FLUSH_BATCH_SIZE`, or starts a debounce timer for `RETAIN_FLUSH_INTERVAL_MS`;
   - on flush, `HindsightRetainQueue.#doFlush(...)` verifies ownership, best-effort ensures the bank exists via `ensureBankExists(...)`, maps items to `MemoryItemInput` with `context ?? config.retainContext`, `metadata.session_id`, and bank-scope tags, then sends one async `retainBatch(...)` request.

## Modes / Variants
- Hindsight tool path: queued batch write only.
- Mnemopi tool path: direct local `remember(...)` into the scoped retain bank.
- Hindsight bank scoping from `computeBankScope(...)`:
  - `global` — one shared bank, no project tags.
  - `per-project` — bank id gets `-<project label>` appended, where the label is the git primary checkout root basename (cwd basename outside a repo).
  - `per-project-tagged` — shared bank plus `project:<project label>` tags on retained memories.
- Mnemopi bank scoping from `computeMnemopiBankScope(...)`:
  - `global` — retain and recall use the shared bank.
  - `per-project` — retain and recall use the project bank.
  - `per-project-tagged` — retain writes project-local memories; recall also reads the shared bank.
- Session scope:
  - tool-called retains are per-session work for the active backend;
  - persisted Hindsight memories are cross-session server-side bank data;
  - persisted Mnemopi memories are local SQLite data;
  - persisted OpenViking archives and extracted memories are server-side resources;
  - subagents alias parent memory state for all three supported backends.

## Side Effects
- Filesystem
  - Hindsight: none for retained memories. No local memory file is written.
  - Mnemopi: writes to local SQLite under `mnemopi.dbPath`, defaulting beneath the agent memories directory (`mnemopi/mnemopi.db`) with one database file per scoped bank when needed.
- Network
  - Hindsight: `POST /v1/default/banks/{bank_id}/memories` via `retainBatch(...)`, plus optional `PUT /v1/default/banks/{bank_id}` via `ensureBankExists(...)` before the first write per bank per session state (the set is created with the primary session state and shared with subagent aliases).
  - Mnemopi: none unless configured embedding or LLM providers make calls during extraction.
  - OpenViking: adds the explicit items to the active remote session, starts an archive/extraction commit, and polls its task status until completion, failure, or the bounded wait expires.
- Session state
  - Hindsight: appends to the in-memory `HindsightRetainQueue`, includes `metadata.session_id`, and shares parent state for subagents.
  - Mnemopi: writes through the session's scoped `Mnemopi` instance, includes `session_id`, `cwd`, and optional `context`, and shares scoped resources with subagents.
  - OpenViking: advances the archived transcript boundary after Phase 1 and persists both ambiguous commit-recovery baselines and unfinished extraction task ids so later lifecycle activity can resume monitoring them.
- User-visible prompts / interactive UI
  - Hindsight async flush failures emit `session.emitNotice("warning", ...)`; the model is not told.
  - Mnemopi write failures are logged by `rememberInScope(...)`; the tool response does not expose per-item failures.
- Background work / cancellation
  - Hindsight flush runs later on timer, queue-size threshold, `agent_end`, backend `enqueue(...)`, or backend `clear(...)`.
  - Mnemopi fact/entity extraction may continue in the Mnemopi runtime; backend `enqueue(...)` calls `flushExtractions()` before sleeping sessions.
  - OpenViking extraction continues server-side after Phase 1. Explicit retains wait boundedly; automatic transcript capture and timed-out explicit retains are monitored in the background without blocking session transitions.

## Limits & Caps
- Input schema requires `items.length >= 1`.
- Tool availability requires `memory.backend` to be `"hindsight"`, `"mnemopi"`, or `"openviking"`; default `memory.backend` is `"off"`.
- Hindsight queue flush threshold: `RETAIN_FLUSH_BATCH_SIZE = 16`.
- Hindsight queue debounce: `RETAIN_FLUSH_INTERVAL_MS = 5_000`.
- Hindsight queue writes use `retainBatch(..., { async: true })`; the client does not wait for server-side consolidation.
- Hindsight auto-retain settings:
  - `hindsight.retainEveryNTurns` default `3`
  - `hindsight.retainOverlapTurns` default `2`
  - `hindsight.retainContext` default `"omp"`
  - `hindsight.retainMode` default `"full-session"`
- Mnemopi retain settings:
  - `mnemopi.retainEveryNTurns` default `4`
  - `mnemopi.autoRetain` controls automatic retention of completed conversation turns
  - `mnemopi.scoping` selects `global`, `per-project`, or `per-project-tagged`
- OpenViking's explicit extraction wait is bounded by `openviking.captureTimeoutMs`; reaching the bound means queued, not failed.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Throws `OpenViking backend is not initialised for this session.` when `memory.backend == "openviking"` but no state exists.
- OpenViking definite Phase 1 request/protocol failures and Phase 2 extraction failures are surfaced as tool errors. An ambiguous Phase 1 response remains reconciling: the client will not repeat the commit or accept another explicit memory input until exactly one new task can be identified from its persisted baseline or persisted session metadata proves Phase 1 completed. A Phase 2 polling timeout is not an error because the server-side task remains queued. Missing, malformed, or interrupted task status is reported as unavailable rather than being mislabeled as queued.
- Hindsight queue enqueue on disposed state throws `Hindsight retain queue is closed.`
- Hindsight flush-time API failures are caught in `HindsightRetainQueue.#doFlush(...)`, logged, and converted into a warning notice instead of a tool error.
- Hindsight bank/mission creation failures are swallowed in `ensureBankExists(...)`; writes continue.
- Mnemopi `remember(...)` failures are caught in `MnemopiSessionState.rememberInScope(...)`, logged, and not rethrown to the tool caller.

## Notes
- Hindsight storage is server-side. `hindsightBackend.clear(...)` only clears local cache/state and warns that upstream deletion must happen in Hindsight UI or `deleteBank`.
- Mnemopi storage is local SQLite. `mnemopiBackend.clear(...)` removes the scoped database files for the active configuration.
- OpenViking commit acceptance means the session archive was written, not that durable-memory extraction finished. Even a completed Phase 2 may extract zero durable memories. Automatic capture accepts Phase 1 and tracks Phase 2 in the background; explicit `retain` calls wait only up to the configured bound.
- `/memory clear` is unsupported for OpenViking: remote memories require resource-scoped deletion, so the backend preserves its active session state and rejects an unsafe bulk clear.
- Hindsight auto-retain uses the same bank but a different path than this tool: `retainSession(...)` extracts plain user/assistant transcript, strips `<memories>` / `<mental_models>` blocks, and calls single-item `retain(...)`.
- Mnemopi auto-retain stores prepared transcripts with `source: "coding-agent-transcript"`, `importance: 0.65`, `veracity: "unknown"`, and `memoryType: "episode"`.
- Hindsight mental-model bootstrap lives in the shared backend: `HindsightSessionState.runMentalModelLoad(...)` optionally resolves seeds, creates missing models, then caches a rendered `<mental_models>` block for prompt injection.
- Built-in Hindsight seeds are `user-preferences`, `project-conventions`, and `project-decisions`. `projectTagged: true` seeds inherit the active scope's retain tags; untagged seeds read the whole bank.
- Hindsight mental-model defaults: `hindsight.mentalModelsEnabled = true`, `hindsight.mentalModelAutoSeed = true`, `hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`, `hindsight.mentalModelMaxRenderChars = 16_000`. First-turn loading waits up to `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`.
- Hindsight seed lifecycle is create-only. Changing `packages/coding-agent/src/hindsight/seeds.json` does not mutate existing server-side models.
- `recall.md` and `reflect.md` rely on the same backend selection and scoping behavior.
