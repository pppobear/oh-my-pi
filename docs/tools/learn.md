# learn

> Capture a reusable lesson into long-term memory and optionally create or update a managed skill.

## Source
- Entry: `packages/coding-agent/src/tools/learn.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/learn.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Local memory backend: `packages/coding-agent/src/memory-backend/local-backend.ts`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `memory` | `string` | Yes | Durable, self-contained lesson to remember: what, when, and why. |
| `context` | `string` | No | Source context for the lesson. |
| `skill` | `{ action: "create" \| "update"; name: string; description: string; body: string }` | No | Managed skill to create or enhance in the same call. |

## Outputs
- Lesson only:
  - `content[0].text` distinguishes stored, queued, zero-memory completion, unavailable/interrupted extraction status, and completed extraction without a reported count.
  - `details = { skill: null }`
- Lesson plus skill:
  - `content[0].text = "<lesson result>. Created managed skill \"<name>\"."` or `"... Updated ..."`
  - `details = { skill: "<name>" }`
- Authored-skill name conflict returns `isError: true` after storing/queueing the lesson and reports `details = { skill: null, shadowed: true }`.

## Flow
1. `LearnTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and `memory.backend` is `"hindsight"`, `"mnemopi"`, `"openviking"`, or `"local"`.
2. `execute(...)` stores the lesson first:
   - Mnemopi: calls `rememberScoped(...)` with `source: "coding-agent-learn"`, `importance: 0.8`, `scope: "bank"`, extraction enabled, `veracity: "tool"`, and `memoryType: "fact"`.
   - Local backend: appends through `localBackend.save(...)` with the same source and importance.
   - OpenViking: adds the lesson to the active remote session, synchronously archives it in commit Phase 1, then polls the asynchronous Phase 2 extraction task for a bounded time. Completion with a positive extracted-memory count reports `Lesson stored`; zero extraction reports `Lesson processed; no durable memory extracted`; timeout reports `Lesson queued for extraction`; task failure throws.
   - Hindsight: enqueues retention with `state.enqueueRetain(memory, context)`.
3. If `skill` is absent, the tool returns after the memory write/queue.
4. If `skill` is present, the tool refuses `create` when an authored skill already claims the same sanitized name.
5. Otherwise, it writes the managed skill through `writeManagedSkill(...)`.

## Modes / Variants
- Memory-only lesson capture.
- Lesson plus managed skill create/update for repeatable procedures worth codifying as `SKILL.md`.
- Backend-specific memory persistence: queued Hindsight, scoped Mnemopi SQLite, two-phase OpenViking archive/extraction, or local files.

## Side Effects
- Filesystem: local memory backend writes under the agent directory; managed skills write to `~/.omp/agent/managed-skills/<name>/SKILL.md`.
- Network: Hindsight retention queues server-side work; OpenViking adds and archives the lesson, then polls its extraction task until completion, failure, or the bounded wait expires; Mnemopi/local paths do not make a network call from this tool directly.
- Session state: reads memory backend state, settings, cwd, and session id.
- Background work: Hindsight retention may flush later. OpenViking extraction continues server-side after archival; a timed-out explicit lesson remains queued and is monitored in the background.

## Limits & Caps
- Availability requires both `autolearn.enabled` and a supported memory backend.
- OpenViking's explicit extraction wait is bounded by `openviking.captureTimeoutMs`; reaching the bound means queued, not failed.
- Managed skill names are sanitized to lowercase kebab-case, max 64 chars, starting with a letter or digit.
- Managed skill final file size is capped at `64_000` UTF-8 bytes.
- Managed skills never override authored skills; authored skills win discovery.

## Errors
- `Mnemopi backend is not initialised for this session.` when Mnemopi state is missing.
- `Mnemopi did not store the lesson (no memory id returned).` when Mnemopi silently fails to write.
- `Lesson was empty after sanitization; nothing stored.` for an empty local-backend lesson.
- `Hindsight backend is not initialised for this session.` when Hindsight state is missing.
- `OpenViking backend is not initialised for this session.` when OpenViking state is missing.
- OpenViking definite Phase 1 failures and Phase 2 extraction failures are surfaced as tool errors. Ambiguous write/archive acknowledgement is matched against a persisted pre-commit task baseline; zero or multiple new tasks remain pending reconciliation, and later lesson input is not sent until that boundary is resolved. Recovery assumes one writer per OpenViking session; without a task, persisted Phase 1 evidence, or an upstream idempotency key, the boundary remains blocked for manual inspection. Reaching the bounded Phase 2 wait reports the lesson as queued; missing, malformed, or interrupted task status is reported as unavailable/interrupted instead.
- Managed-skill write failures are rethrown as `<lesson result>, but the managed skill could not be written: <reason>`.

## Notes
- Use this tool sparingly. One precise reusable lesson is better than several vague memories.
- Put `skill` only on repeatable procedures; ordinary facts should remain memory-only.
- Managed skills are isolated from user-authored skills and are discovered in future sessions like normal skills.
- For OpenViking, successful commit acceptance confirms the session archive only; `Lesson stored` is reserved for completed Phase 2 extraction that reports at least one durable memory.
