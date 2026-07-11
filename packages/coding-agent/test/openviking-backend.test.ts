import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createMemoryRuntimeContext, resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { openVikingBackend } from "@oh-my-pi/pi-coding-agent/openviking/backend";
import {
	OpenVikingApi,
	type OpenVikingFetchResult,
	type OpenVikingMessagePayload,
	type OpenVikingTask,
	type OpenVikingTaskWaitResult,
} from "@oh-my-pi/pi-coding-agent/openviking/client";
import { loadOpenVikingConfig, type OpenVikingConfig } from "@oh-my-pi/pi-coding-agent/openviking/config";
import {
	getOpenVikingSessionState,
	OpenVikingSessionState,
	setOpenVikingSessionState,
} from "@oh-my-pi/pi-coding-agent/openviking/state";
import { AgentSession, type AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";

const baseConfig: OpenVikingConfig = {
	baseUrl: "http://openviking.test",
	apiKey: null,
	accountId: null,
	userId: null,
	peerId: null,
	timeoutMs: 1_000,
	captureTimeoutMs: 1_000,
	autoRecall: true,
	autoRetain: true,
	recallLimit: 4,
	scoreThreshold: 0.35,
	minQueryLength: 3,
	recallMaxContentChars: 500,
	recallTokenBudget: 2_000,
	recallPreferAbstract: true,
	recallContextTurns: 3,
	captureAssistantTurns: true,
	commitEveryNTurns: 2,
	debug: false,
};

function commitAccepted(taskId = "task-1", sessionId = "omp-session-1") {
	return {
		ok: true as const,
		result: {
			status: "accepted" as const,
			session_id: sessionId,
			archived: true as const,
			task_id: taskId,
			archive_uri: `viking://session/${sessionId}/history/archive_001`,
		},
	};
}

function commitSkipped(sessionId = "omp-session-1") {
	return {
		ok: true as const,
		result: {
			status: "skipped" as const,
			session_id: sessionId,
			archived: false as const,
			task_id: null,
			archive_uri: null,
			reason: "no_messages",
		},
	};
}

function extractionCompleted(taskId = "task-1", memoriesExtracted: Record<string, number> = { preferences: 1 }) {
	return {
		status: "completed" as const,
		task: {
			task_id: taskId,
			task_type: "session_commit",
			status: "completed" as const,
			result: { memories_extracted: memoriesExtracted },
		},
	};
}

const OPENVIKING_ENV_KEYS = [
	"OPENVIKING_URL",
	"OPENVIKING_BASE_URL",
	"OPENVIKING_CONFIG_FILE",
	"OPENVIKING_CLI_CONFIG_FILE",
] as const;
const savedOpenVikingEnv: Partial<Record<(typeof OPENVIKING_ENV_KEYS)[number], string>> = {};
const MISSING_OPENVIKING_CONFIG = "/tmp/omp-openviking-test-missing.conf";

function makeFakeSession(settings: Settings, entries: Array<{ role: "user" | "assistant"; content: string }> = []) {
	const listeners = new Set<AgentSessionEventListener>();
	const customEntries: CustomEntry[] = [];
	const notices: Array<{ level: string; message: string; source?: string }> = [];
	const sessionEntries = (): SessionEntry[] => [
		...entries.map(
			(entry, index) =>
				({
					id: `message-${index}`,
					parentId: index === 0 ? null : `message-${index - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message",
					message: entry,
				}) as SessionEntry,
		),
		...customEntries,
	];
	const session = {
		sessionId: "session-1",
		settings,
		sessionManager: {
			getEntries: sessionEntries,
			getBranch: sessionEntries,
			appendCustomEntry(customType: string, data?: unknown) {
				const index = customEntries.length;
				const entry: CustomEntry = {
					id: `custom-${index}`,
					parentId: entries.length > 0 ? `message-${entries.length - 1}` : null,
					timestamp: new Date(0).toISOString(),
					type: "custom",
					customType,
					data,
				};
				customEntries.push(entry);
				return entry.id;
			},
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const listener of listeners) listener(event);
		},
		emitNotice(level: string, message: string, source?: string) {
			notices.push({ level, message, source });
		},
		customEntries,
		notices,
	} as never;
	return session as {
		sessionId: string;
		settings: Settings;
		sessionManager: { appendCustomEntry(customType: string, data?: unknown): string };
		emit(event: Parameters<AgentSessionEventListener>[0]): void;
		customEntries: CustomEntry[];
		notices: Array<{ level: string; message: string; source?: string }>;
	};
}

describe("OpenViking memory backend", () => {
	beforeEach(() => {
		for (const key of OPENVIKING_ENV_KEYS) {
			savedOpenVikingEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.OPENVIKING_CONFIG_FILE = MISSING_OPENVIKING_CONFIG;
		process.env.OPENVIKING_CLI_CONFIG_FILE = MISSING_OPENVIKING_CONFIG;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const key of OPENVIKING_ENV_KEYS) {
			if (savedOpenVikingEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedOpenVikingEnv[key];
		}
	});

	it("resolves as the active memory backend", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const backend = await resolveMemoryBackend(settings);
		expect(backend.id).toBe("openviking");
	});

	it("allows OpenViking recall, retain, and reflect tools", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const tools = await createTools(
			{
				settings,
				cwd: "/tmp/project",
				getSessionSpawns: () => null,
			} as never,
			["recall", "retain", "reflect"],
		);
		expect(tools.map(tool => tool.name).sort()).toEqual(["recall", "reflect", "resolve", "retain"]);
	});

	it("reports runtime status through the OpenViking health endpoint", async () => {
		const settings = Settings.isolated({
			"memory.backend": "openviking",
			"openviking.apiUrl": "http://openviking.test",
		});
		const requestedPaths: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof fetch>[0]) => {
			requestedPaths.push(new URL(String(url)).pathname + new URL(String(url)).search);
			return Response.json({ status: "ok", result: {} });
		}) as unknown as typeof fetch);
		const session = makeFakeSession(settings);
		const backend = await resolveMemoryBackend(settings);
		await backend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: session as never,
		});

		await expect(memory.status()).resolves.toMatchObject({
			backend: "openviking",
			active: true,
			writable: true,
			searchable: true,
			database: "http://openviking.test",
		});
		expect(requestedPaths).toContain("/api/v1/sessions/omp-session-1?auto_create=true");
		expect(requestedPaths).toContain("/health");
		expect(requestedPaths).toContain("/ready");
		expect(requestedPaths).toContain("/api/v1/sessions/omp-session-1?auto_create=false");
	});

	it("injects searched OpenViking context before an agent turn", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			search: vi.fn(async () => [
				{
					uri: "viking://user/default/memories/preferences/editor.md",
					score: 0.9,
					abstract: "Prefers concise code reviews.",
					_sourceType: "memory",
				},
			]),
			readContent: vi.fn(),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		setOpenVikingSessionState(session as never, state);

		const injected = await state.beforeAgentStartPrompt("How should I review this PR?");

		expect(injected).toContain("<openviking-context>");
		expect(injected).toContain("Prefers concise code reviews.");
		expect(client.search).toHaveBeenCalled();
	});

	it("exposes recalled OpenViking documents through memory URLs", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, recallTokenBudget: 0 },
			client: {} as OpenVikingApi,
			session: session as never,
		});

		const formatted = await state.formatItems(
			[
				{
					uri: "viking://user/default/memories/preferences/editor.md",
					score: 0.9,
					_sourceType: "memory",
				},
			],
			true,
		);

		expect(formatted).toContain("memory://user/default/memories/preferences/editor.md");
		expect(formatted).not.toContain("viking://");
	});

	it("returns memory URLs from backend searches", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			search: vi.fn(async () => [
				{
					uri: "viking://user/default/memories/preferences/editor.md",
					score: 0.9,
					abstract: "Editor preference",
					_sourceType: "memory",
				},
			]),
		} as unknown as OpenVikingApi;
		setOpenVikingSessionState(
			session as never,
			new OpenVikingSessionState({
				sessionId: "session-1",
				config: baseConfig,
				client,
				session: session as never,
			}),
		);

		const result = await openVikingBackend.search?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: session as never },
			"editor",
		);

		expect(result?.items).toEqual([
			expect.objectContaining({
				id: "memory://user/default/memories/preferences/editor.md",
				content: "Editor preference",
				metadata: expect.objectContaining({ uri: "memory://user/default/memories/preferences/editor.md" }),
			}),
		]);
	});

	it("maps explicit save outcomes without overstating stored or queued state", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client: {} as OpenVikingApi,
			session: session as never,
		});
		setOpenVikingSessionState(session as never, state);
		const save = vi.spyOn(state, "save");
		const context = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: session as never };

		save.mockResolvedValueOnce({
			status: "stored",
			taskId: "task-1",
			archiveUri: "viking://session/archive-1",
			extracted: 2,
		});
		await expect(openVikingBackend.save?.(context, { content: "stored" })).resolves.toEqual({
			backend: "openviking",
			stored: 2,
		});

		save.mockResolvedValueOnce({
			status: "completed",
			taskId: "task-2",
			archiveUri: "viking://session/archive-2",
			extracted: 0,
		});
		await expect(openVikingBackend.save?.(context, { content: "empty" })).resolves.toEqual({
			backend: "openviking",
			stored: 0,
			message: "OpenViking completed extraction without creating a durable memory.",
		});

		save.mockResolvedValueOnce({
			status: "queued",
			taskId: "task-3",
			archiveUri: "viking://session/archive-3",
			reason: "timeout",
			message: "still running",
		});
		await expect(openVikingBackend.save?.(context, { content: "queued" })).resolves.toEqual({
			backend: "openviking",
			stored: 0,
			queued: true,
			message: "still running",
		});

		save.mockResolvedValueOnce({
			status: "queued",
			taskId: "task-4",
			archiveUri: "viking://session/archive-4",
			reason: "unknown",
			message: "status unavailable",
		});
		await expect(openVikingBackend.save?.(context, { content: "unknown" })).resolves.toEqual({
			backend: "openviking",
			stored: 0,
			message: "status unavailable",
		});

		save.mockResolvedValueOnce({ status: "reconciling", message: "commit acknowledgement unavailable" });
		await expect(openVikingBackend.save?.(context, { content: "reconciling" })).resolves.toEqual({
			backend: "openviking",
			stored: 0,
			message: "commit acknowledgement unavailable",
		});

		save.mockResolvedValueOnce({ status: "failed", error: "write failed" });
		await expect(openVikingBackend.save?.(context, { content: "failed" })).resolves.toEqual({
			backend: "openviking",
			stored: 0,
			message: "write failed",
		});
	});

	it("uses the child session transcript for subagent OpenViking recall", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const parentSession = makeFakeSession(settings, [{ role: "user", content: "parent-only transcript" }]);
		const childSession = makeFakeSession(settings, [{ role: "user", content: "child-only transcript" }]);
		let observedQuery = "";
		const client = {
			search: vi.fn(async (query: string) => {
				observedQuery = query;
				return [
					{
						uri: "viking://user/default/memories/preferences/child.md",
						score: 0.9,
						abstract: "Child-local memory.",
						_sourceType: "memory",
					},
				];
			}),
			readContent: vi.fn(),
		} as unknown as OpenVikingApi;
		const parent = new OpenVikingSessionState({
			sessionId: "parent",
			config: baseConfig,
			client,
			session: parentSession as never,
		});
		const child = new OpenVikingSessionState({
			sessionId: "child",
			config: baseConfig,
			client,
			session: childSession as never,
			aliasOf: parent,
		});
		setOpenVikingSessionState(childSession as never, child);

		const injected = await openVikingBackend.beforeAgentStartPrompt?.(childSession as never, "child prompt");

		expect(injected).toContain("Child-local memory.");
		expect(observedQuery).toContain("child-only transcript");
		expect(observedQuery).not.toContain("parent-only transcript");
		expect(child.lastRecallSnippet).toContain("Child-local memory.");
		expect(parent.lastRecallSnippet).toBeUndefined();
	});

	it("commits explicit saves before reporting stored", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => extractionCompleted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("remember this", "manual")).resolves.toMatchObject({
			status: "stored",
			taskId: "task-1",
		});
		expect(client.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			content: "remember this\n\nContext: manual",
		});
		expect(client.commitSession).toHaveBeenCalledWith("omp-session-1");
		expect(client.waitForCommitTask).toHaveBeenCalledWith(
			"task-1",
			expect.objectContaining({ timeoutMs: baseConfig.captureTimeoutMs, signal: expect.any(AbortSignal) }),
		);
	});

	it("reports explicit saves as queued when Phase 2 outlives the bounded wait", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => ({
				status: "timeout" as const,
				task: { task_id: "task-1", task_type: "session_commit", status: "running" as const },
			})),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("remember later")).resolves.toMatchObject({ status: "queued", taskId: "task-1" });
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("does not append a late Phase 2 cursor after the state is disposed", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const waitStarted = Promise.withResolvers<void>();
		const releaseWait = Promise.withResolvers<Extract<OpenVikingTaskWaitResult, { status: "completed" }>>();
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => {
				waitStarted.resolve();
				return await releaseWait.promise;
			}),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		const save = state.save("finish after dispose");
		await waitStarted.promise;
		await state.dispose({ flush: false });
		const cursorCountAfterDispose = session.customEntries.length;
		releaseWait.resolve(extractionCompleted());
		await save;

		expect(session.customEntries).toHaveLength(cursorCountAfterDispose);
	});

	it("does not report stored when Phase 2 completes without extracting a durable memory", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => extractionCompleted("task-1", {})),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("not durable enough")).resolves.toMatchObject({ status: "completed", extracted: 0 });
	});

	it("surfaces Phase 2 failures and emits a session warning", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => ({
				status: "failed" as const,
				error: "extractor unavailable",
				task: {
					task_id: "task-1",
					task_type: "session_commit",
					status: "failed" as const,
					error: "extractor unavailable",
				},
			})),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("remember this")).resolves.toEqual({
			status: "failed",
			error: "OpenViking memory extraction failed: extractor unavailable",
		});
		expect(session.notices).toEqual([
			expect.objectContaining({
				level: "warning",
				message: expect.stringContaining("memory extraction failed: extractor unavailable"),
				source: "OpenViking",
			}),
		]);
	});

	it("quarantines a protocol-invalid Phase 2 task instead of polling forever", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => ({
				status: "unknown" as const,
				reason: "protocol" as const,
				error: "wrong resource_id",
			})),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("remember this")).resolves.toEqual({
			status: "failed",
			error: "OpenViking extraction task validation failed: wrong resource_id",
		});
		expect(client.waitForCommitTask).toHaveBeenCalledTimes(1);
		const latestCursor = session.customEntries.at(-1)?.data as { pendingExtractions?: unknown[] } | undefined;
		expect(latestCursor?.pendingExtractions).toEqual([]);
		expect(session.notices.at(-1)?.message).toContain("can no longer be verified: wrong resource_id");
	});

	it("batches explicit retains into one archive and reports the extracted count", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => extractionCompleted("task-1", { preferences: 1, entities: 1 })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(
			state.saveMany([{ content: "first" }, { content: "second", context: "manual" }]),
		).resolves.toMatchObject({ status: "stored", extracted: 2 });
		expect(client.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			parts: [
				{ type: "text", text: "first\n\n" },
				{ type: "text", text: "second\n\nContext: manual\n\n" },
			],
		});
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("does not partially send a multi-item explicit retain when its atomic request fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, status: 503, error: "unavailable" })),
			commitSession: vi.fn(async () => commitSkipped()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.saveMany([{ content: "first" }, { content: "second" }])).resolves.toEqual({
			status: "failed",
			error: "OpenViking did not accept the memory write (unavailable); archive reconciliation found no remote session tail.",
		});
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("recovers an ambiguously acknowledged explicit write by archiving the remote tail", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, error: "response lost" })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => extractionCompleted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("ambiguous write")).resolves.toMatchObject({ status: "stored", extracted: 1 });
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("recovers a lost commit acknowledgement from the unique new session task", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const oldTask = {
			task_id: "task-old",
			task_type: "session_commit",
			status: "completed" as const,
			resource_id: "omp-session-1",
		};
		const recoveredTask = {
			task_id: "task-recovered",
			task_type: "session_commit",
			status: "running" as const,
			resource_id: "omp-session-1",
			created_at: 42,
		};
		const listCommitTasks = vi
			.fn(async (): Promise<OpenVikingFetchResult<OpenVikingTask[]>> => ({ ok: true, result: [oldTask] }))
			.mockResolvedValueOnce({ ok: true, result: [oldTask] })
			.mockResolvedValueOnce({ ok: true, result: [recoveredTask, oldTask] });
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			getSession: vi.fn(async () => ({
				ok: true as const,
				result: {
					session_id: "omp-session-1",
					uri: "viking://user/test/sessions/omp-session-1",
					commit_count: 1,
					message_count: 1,
				},
			})),
			listCommitTasks,
			commitSession: vi.fn(async () => ({ ok: false, error: "response lost" })),
			waitForCommitTask: vi.fn(async () => ({
				status: "completed" as const,
				task: {
					...recoveredTask,
					status: "completed" as const,
					result: {
						archive_uri: "viking://session/omp-session-1/history/archive_002",
						memories_extracted: { preferences: 1 },
					},
				},
			})),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("recover me")).resolves.toEqual({
			status: "stored",
			taskId: "task-recovered",
			archiveUri: "viking://session/omp-session-1/history/archive_002",
			extracted: 1,
		});
		expect(listCommitTasks).toHaveBeenCalledTimes(2);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("does not POST commit or duplicate a write when task-baseline acquisition fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks: vi.fn(async () => ({ ok: false, status: 503, error: "task list unavailable" })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("first attempt")).resolves.toMatchObject({ status: "reconciling" });
		await expect(state.save("retry must not duplicate")).resolves.toMatchObject({ status: "reconciling" });
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).not.toHaveBeenCalled();
		expect(client.listCommitTasks).toHaveBeenCalledTimes(2);
	});

	it("keeps a zero-delta 503 commit reconciling without re-POSTing or accepting new input", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks: vi.fn(async () => ({ ok: true as const, result: [] })),
			commitSession: vi.fn(async () => ({ ok: false, status: 503, error: "upstream timeout" })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("first attempt")).resolves.toMatchObject({ status: "reconciling" });
		await expect(state.save("must wait")).resolves.toMatchObject({ status: "reconciling" });
		await expect(state.retainMessages([{ role: "user", content: "must also wait" }])).resolves.toBe(false);
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
		expect(client.listCommitTasks).toHaveBeenCalledTimes(4);
	});

	it("does not retry an expired zero-delta recovery without persisted Phase 1 evidence", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "pending tail" }]);
		session.customEntries.push({
			id: "expired-recovery-cursor",
			parentId: "message-0",
			timestamp: new Date(0).toISOString(),
			type: "custom",
			customType: "openviking-capture-cursor",
			data: {
				version: 4,
				identity: {
					baseUrl: baseConfig.baseUrl,
					credentialFingerprint: null,
					accountId: null,
					userId: null,
					peerId: null,
					sessionId: "omp-session-1",
				},
				capturedMessageCount: 1,
				archivedUserTurns: 0,
				hasUnarchivedRemoteMessages: true,
				commitTaskBaseline: {
					taskIds: [],
					preparedAt: 0,
					throughMessageCount: 1,
					throughUserTurns: 1,
				},
				pendingExtractions: [],
			},
		});
		const client = {
			baseUrl: baseConfig.baseUrl,
			listCommitTasks: vi.fn(async () => ({ ok: true as const, result: [] })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.commit()).resolves.toBe(false);
		expect(client.commitSession).not.toHaveBeenCalled();
		expect(session.customEntries.at(-1)?.data).toMatchObject({
			hasUnarchivedRemoteMessages: true,
			commitTaskBaseline: { taskIds: [], preparedAt: 0 },
		});

		await expect(state.commit()).resolves.toBe(false);
		expect(client.commitSession).not.toHaveBeenCalled();
	});

	it("unblocks an archived tail without reporting stored when Phase 1 has no visible task", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "archived tail" }]);
		session.customEntries.push({
			id: "orphaned-recovery-cursor",
			parentId: "message-0",
			timestamp: new Date(0).toISOString(),
			type: "custom",
			customType: "openviking-capture-cursor",
			data: {
				version: 4,
				identity: {
					baseUrl: baseConfig.baseUrl,
					credentialFingerprint: null,
					accountId: null,
					userId: null,
					peerId: null,
					sessionId: "omp-session-1",
				},
				capturedMessageCount: 1,
				archivedUserTurns: 0,
				hasUnarchivedRemoteMessages: true,
				commitTaskBaseline: {
					taskIds: [],
					preparedAt: 0,
					commitCount: 1,
					messageCount: 1,
					sessionUri: "viking://user/test/sessions/omp-session-1",
					throughMessageCount: 1,
					throughUserTurns: 1,
				},
				pendingExtractions: [],
			},
		});
		const client = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			getSession: vi.fn(async () => ({
				ok: true as const,
				result: {
					session_id: "omp-session-1",
					uri: "viking://user/test/sessions/omp-session-1",
					commit_count: 2,
					message_count: 0,
				},
			})),
			listCommitTasks: vi.fn(async () => ({ ok: true as const, result: [] })),
			commitSession: vi.fn(async () => commitSkipped()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("must not be mistaken for stored")).resolves.toEqual({
			status: "reconciling",
			message:
				"OpenViking archived the pending tail but exposed no extraction task before the recovery window expired (viking://user/test/sessions/omp-session-1/history/archive_002); this new memory input was not sent.",
		});
		expect(client.addMessage).not.toHaveBeenCalled();
		expect(client.commitSession).not.toHaveBeenCalled();
		expect(session.customEntries.at(-1)?.data).toMatchObject({
			archivedUserTurns: 1,
			hasUnarchivedRemoteMessages: false,
			commitTaskBaseline: null,
		});
	});

	it("refuses to guess when multiple new commit tasks appear after an ambiguous response", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const tasks = ["task-a", "task-b"].map(taskId => ({
			task_id: taskId,
			task_type: "session_commit",
			status: "running" as const,
			resource_id: "omp-session-1",
		}));
		const listCommitTasks = vi
			.fn(async (): Promise<OpenVikingFetchResult<OpenVikingTask[]>> => ({ ok: true, result: [] }))
			.mockResolvedValueOnce({ ok: true, result: [] })
			.mockResolvedValueOnce({ ok: true, result: tasks });
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks,
			commitSession: vi.fn(async () => ({ ok: false, error: "response lost" })),
			waitForCommitTask: vi.fn(async () => extractionCompleted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("ambiguous")).resolves.toMatchObject({ status: "reconciling" });
		expect(client.waitForCommitTask).not.toHaveBeenCalled();
	});

	it("restores a persisted task baseline and adopts its unique task without re-POSTing", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const firstClient = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks: vi.fn(async () => ({ ok: true as const, result: [] })),
			commitSession: vi.fn(async () => ({ ok: false, error: "response lost" })),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client: firstClient,
			session: session as never,
		});
		await expect(firstState.save("persist recovery")).resolves.toMatchObject({ status: "reconciling" });

		const recoveredTask = {
			task_id: "task-after-restart",
			task_type: "session_commit",
			status: "running" as const,
			resource_id: "omp-session-1",
		};
		const secondClient = {
			baseUrl: baseConfig.baseUrl,
			listCommitTasks: vi.fn(async () => ({ ok: true as const, result: [recoveredTask] })),
			commitSession: vi.fn(async () => commitSkipped()),
		} as unknown as OpenVikingApi;
		const resumedState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client: secondClient,
			session: session as never,
		});

		await expect(resumedState.commit()).resolves.toBe(true);
		expect(secondClient.commitSession).not.toHaveBeenCalled();
		const latestCursor = session.customEntries.at(-1)?.data as
			| {
					version?: number;
					commitTaskBaseline?: unknown;
					pendingExtractions?: Array<{ taskId?: string; archiveUri?: string | null }>;
			  }
			| undefined;
		expect(latestCursor).toMatchObject({
			version: 4,
			commitTaskBaseline: null,
			pendingExtractions: [{ taskId: "task-after-restart", archiveUri: null }],
		});
	});

	it("reconciles an ambiguous commit in the background once its task appears", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const recoveredTask = {
			task_id: "task-background",
			task_type: "session_commit",
			status: "running" as const,
			resource_id: "omp-session-1",
		};
		let listCall = 0;
		const waitForCommitTask = vi.fn(async () => ({
			status: "completed" as const,
			task: {
				...recoveredTask,
				status: "completed" as const,
				result: {
					archive_uri: "viking://session/omp-session-1/history/archive_003",
					memories_extracted: { preferences: 1 },
				},
			},
		}));
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks: vi.fn(async () => {
				listCall += 1;
				return { ok: true as const, result: listCall >= 3 ? [recoveredTask] : [] };
			}),
			commitSession: vi.fn(async () => ({ ok: false, error: "response lost" })),
			waitForCommitTask,
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, captureTimeoutMs: 5 },
			client,
			session: session as never,
		});
		state.attachSessionListeners();

		await expect(state.save("background recovery")).resolves.toMatchObject({ status: "reconciling" });
		for (let attempt = 0; attempt < 20 && waitForCommitTask.mock.calls.length === 0; attempt += 1) {
			await Bun.sleep(1);
		}
		expect(waitForCommitTask).toHaveBeenCalledTimes(1);
		expect(session.notices).toContainEqual({
			level: "info",
			message: "OpenViking recovered the commit task whose response was unavailable.",
			source: "OpenViking",
		});
		await state.dispose({ flush: false });
	});

	it("uses the original through-counters when recovery completes before a newer transcript capture", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "first turn" }];
		const session = makeFakeSession(settings, entries);
		const recoveredTask = {
			task_id: "task-first-tail",
			task_type: "session_commit",
			status: "running" as const,
			resource_id: "omp-session-1",
		};
		let listCall = 0;
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			listCommitTasks: vi.fn(async () => {
				listCall += 1;
				return { ok: true as const, result: listCall >= 3 ? [recoveredTask] : [] };
			}),
			commitSession: vi.fn(async () => ({ ok: false, error: "response lost" })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 99 },
			client,
			session: session as never,
		});

		await state.maybeRetainOnAgentEnd([]);
		await expect(state.flushAndCommit()).resolves.toBe(false);
		entries.push({ role: "user", content: "newer turn" });
		await state.maybeRetainOnAgentEnd([]);

		expect(client.addMessage).toHaveBeenCalledTimes(2);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
		const latestCursor = session.customEntries.at(-1)?.data as
			| {
					capturedMessageCount?: number;
					archivedUserTurns?: number;
					hasUnarchivedRemoteMessages?: boolean;
					pendingExtractions?: Array<{ throughMessageCount?: number; throughUserTurns?: number }>;
			  }
			| undefined;
		expect(latestCursor).toMatchObject({
			capturedMessageCount: 2,
			archivedUserTurns: 1,
			hasUnarchivedRemoteMessages: true,
			pendingExtractions: [{ throughMessageCount: 1, throughUserTurns: 1 }],
		});
	});

	it("keeps large explicit retain sets atomic in one message", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const addMessage = vi.fn(async (_sessionId: string, _payload: OpenVikingMessagePayload) => ({ ok: true }));
		const client = {
			addMessage,
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => extractionCompleted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(
			state.saveMany(Array.from({ length: 101 }, (_, index) => ({ content: `memory ${index}` }))),
		).resolves.toMatchObject({ status: "stored" });
		expect(addMessage).toHaveBeenCalledTimes(1);
		const payload = addMessage.mock.calls[0]?.[1];
		expect(payload?.parts).toHaveLength(101);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("retries a definitely failed explicit Phase 1 during disposal even when auto-retain is disabled", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		let commitAttempt = 0;
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => {
				commitAttempt += 1;
				return commitAttempt === 1 ? { ok: false, status: 409, error: "temporary" } : commitAccepted();
			}),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, autoRetain: false },
			client,
			session: session as never,
		});

		await expect(state.save("retry me")).resolves.toEqual({ status: "failed", error: "temporary" });
		await expect(state.dispose()).resolves.toBe(true);
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(2);
	});

	it("does not send a new explicit write while a pre-existing pending tail is being archived", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "existing tail" }]);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 99 },
			client,
			session: session as never,
		});
		await state.maybeRetainOnAgentEnd([]);
		const appendCursor = vi.spyOn(session.sessionManager, "appendCustomEntry");
		appendCursor.mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(state.save("manual write")).resolves.toEqual({
			status: "reconciling",
			message:
				"OpenViking archived the previously pending session tail; this new memory input was not sent. Retry it after reconciliation completes.",
		});
		await expect(state.dispose()).resolves.toBe(true);

		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
	});

	it("does not send an explicit write when its retry cursor cannot be persisted", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		vi.spyOn(session.sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(state.save("manual write")).resolves.toEqual({
			status: "failed",
			error: "OpenViking memory was not sent because its retry cursor could not be saved.",
		});
		expect(client.addMessage).not.toHaveBeenCalled();
		expect(client.commitSession).not.toHaveBeenCalled();
	});

	it("does not advance auto-capture counters when OpenViking writes fail", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "turn one" }]);
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, error: "down" })),
			commitSession: vi.fn(async sessionId => commitAccepted("task-1", sessionId)),
			waitForCommitTask: vi.fn(async () => extractionCompleted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
			lastCapturedMessageCount: 0,
			lastCommittedTurn: 0,
		});

		await state.maybeRetainOnAgentEnd([]);
		expect(state.lastCapturedMessageCount).toBe(0);
		expect(client.commitSession).not.toHaveBeenCalled();
	});

	it("replays without a cursor, then resumes from the persisted active-branch cursor", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "already persisted" }];
		const session = makeFakeSession(settings, entries);
		const addMessage = vi.fn(async () => ({ ok: true }));
		const client = {
			addMessage,
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await firstState.maybeRetainOnAgentEnd([]);
		expect(client.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			content: "already persisted",
		});
		addMessage.mockClear();

		const resumedState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		await resumedState.maybeRetainOnAgentEnd([]);
		expect(client.addMessage).not.toHaveBeenCalled();

		entries.push({ role: "user", content: "new turn" });
		await resumedState.maybeRetainOnAgentEnd([]);

		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.addMessage).toHaveBeenCalledWith("omp-session-1", { role: "user", content: "new turn" });
	});

	it("resumes persisted Phase 2 monitoring without replaying archived messages", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "already archived" }];
		const session = makeFakeSession(settings, entries);
		const firstClient = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client: firstClient,
			session: session as never,
		});
		await firstState.maybeRetainOnAgentEnd([]);

		const waitStarted = Promise.withResolvers<void>();
		const secondClient = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
			waitForCommitTask: vi.fn(async () => {
				waitStarted.resolve();
				return extractionCompleted();
			}),
		} as unknown as OpenVikingApi;
		const resumedState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client: secondClient,
			session: session as never,
		});

		resumedState.attachSessionListeners();
		await waitStarted.promise;
		await Bun.sleep(0);

		expect(secondClient.addMessage).not.toHaveBeenCalled();
		const latestCursor = session.customEntries.at(-1)?.data as { pendingExtractions?: unknown[] } | undefined;
		expect(latestCursor?.pendingExtractions).toEqual([]);
		await resumedState.dispose({ flush: false });
	});

	it("commits an uncommitted tail when the state is disposed", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries: Array<{ role: "user" | "assistant"; content: string }> = [];
		const session = makeFakeSession(settings, entries);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 4 },
			client,
			session: session as never,
		});

		entries.push({ role: "user", content: "short session tail" });
		await state.maybeRetainOnAgentEnd([]);
		expect(client.commitSession).not.toHaveBeenCalled();

		await state.dispose();

		expect(client.commitSession).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledWith("omp-session-1");
	});

	it("serializes capture with rekey and keeps queued writes on their session snapshot", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries: Array<{ role: "user" | "assistant"; content: string }> = [];
		const session = makeFakeSession(settings, entries);
		const firstWriteStarted = Promise.withResolvers<void>();
		const releaseFirstWrite = Promise.withResolvers<void>();
		const writes: Array<{ sessionId: string; content: string }> = [];
		const client = {
			addMessage: vi.fn(async (sessionId: string, payload: { content?: string }) => {
				writes.push({ sessionId, content: payload.content ?? "" });
				if (writes.length === 1) {
					firstWriteStarted.resolve();
					await releaseFirstWrite.promise;
				}
				return { ok: true };
			}),
			commitSession: vi.fn(async sessionId => commitAccepted(`task-${sessionId}`, sessionId)),
			waitForCommitTask: vi.fn(async taskId => extractionCompleted(taskId)),
			ensureSession: vi.fn(async () => ({ ok: true })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 99 },
			client,
			session: session as never,
		});

		entries.push({ role: "user", content: "old one" });
		const firstCapture = state.maybeRetainOnAgentEnd([]);
		await firstWriteStarted.promise;
		entries.push({ role: "user", content: "old two" });
		const secondCapture = state.maybeRetainOnAgentEnd([]);
		const rekey = state.rekeySession("session-2", { baselineExistingTranscript: true });
		const sameTickSave = state.save("manual after rekey");
		releaseFirstWrite.resolve();
		await Promise.all([firstCapture, secondCapture, rekey, sameTickSave]);

		expect(writes).toEqual([
			{ sessionId: "omp-session-1", content: "old one" },
			{ sessionId: "omp-session-1", content: "old two" },
			{ sessionId: "omp-session-2", content: "manual after rekey" },
		]);
		expect(client.ensureSession).toHaveBeenCalledWith("omp-session-2");

		entries.push({ role: "user", content: "new session turn" });
		await state.maybeRetainOnAgentEnd([]);
		expect(writes.at(-1)).toEqual({ sessionId: "omp-session-2", content: "new session turn" });
	});

	it("does not monitor an old capture task under a newly published rekey identity", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "old session turn" }];
		const session = makeFakeSession(settings, entries);
		const commitStarted = Promise.withResolvers<void>();
		const releaseCommit = Promise.withResolvers<void>();
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => {
				commitStarted.resolve();
				await releaseCommit.promise;
				return commitAccepted("old-task", "omp-session-1");
			}),
			ensureSession: vi.fn(async () => ({ ok: true })),
			waitForCommitTask: vi.fn(async () => extractionCompleted("old-task")),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client,
			session: session as never,
		});
		state.attachSessionListeners();

		const capture = state.maybeRetainOnAgentEnd([]);
		await commitStarted.promise;
		const rekey = state.rekeySession("session-2", { baselineExistingTranscript: true });
		releaseCommit.resolve();
		await Promise.all([capture, rekey]);

		expect(state.sessionId).toBe("omp-session-2");
		expect(client.waitForCommitTask).not.toHaveBeenCalled();
		await state.dispose({ flush: false });
	});

	it("drops a stale same-tick rekey after its ensure request returns", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const firstEnsureStarted = Promise.withResolvers<void>();
		const releaseFirstEnsure = Promise.withResolvers<void>();
		let ensureCount = 0;
		const client = {
			ensureSession: vi.fn(async () => {
				ensureCount += 1;
				if (ensureCount === 1) {
					firstEnsureStarted.resolve();
					await releaseFirstEnsure.promise;
				}
				return { ok: true };
			}),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-0",
			config: baseConfig,
			client,
			session: session as never,
		});

		const first = state.rekeySession("session-1");
		await firstEnsureStarted.promise;
		const second = state.rekeySession("session-2");
		releaseFirstEnsure.resolve();

		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
		expect(state.sessionId).toBe("omp-session-2");
	});

	it("retries only the failed suffix after a partial capture failure", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [
			{ role: "user" as const, content: "first" },
			{ role: "user" as const, content: "second" },
		];
		const session = makeFakeSession(settings, entries);
		let attempt = 0;
		const sent: string[] = [];
		const client = {
			addMessage: vi.fn(async (_sessionId: string, payload: { content?: string }) => {
				attempt += 1;
				sent.push(payload.content ?? "");
				return attempt === 2 ? { ok: false, error: "temporary" } : { ok: true };
			}),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 99 },
			client,
			session: session as never,
			lastCapturedMessageCount: 0,
			lastCommittedTurn: 0,
		});

		await state.maybeRetainOnAgentEnd([]);
		const resumedState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 99 },
			client,
			session: session as never,
		});
		await resumedState.maybeRetainOnAgentEnd([]);

		expect(sent).toEqual(["first", "second", "second"]);
	});

	it("restores a pending commit without re-adding captured messages", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "captured before commit failed" }];
		const session = makeFakeSession(settings, entries);
		let commitAttempt = 0;
		const addMessage = vi.fn(async () => ({ ok: true }));
		const client = {
			addMessage,
			commitSession: vi.fn(async () => {
				commitAttempt += 1;
				return commitAttempt === 1 ? { ok: false, error: "temporary" } : commitAccepted();
			}),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client,
			session: session as never,
			lastCapturedMessageCount: 0,
			lastCommittedTurn: 0,
		});

		await firstState.maybeRetainOnAgentEnd([]);
		expect(client.addMessage).toHaveBeenCalledTimes(1);
		expect(client.commitSession).toHaveBeenCalledTimes(1);
		addMessage.mockClear();

		const resumedState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client,
			session: session as never,
		});
		await resumedState.maybeRetainOnAgentEnd([]);

		expect(client.addMessage).not.toHaveBeenCalled();
		expect(client.commitSession).toHaveBeenCalledTimes(2);
	});

	it("migrates a v2 cursor and archives its uncommitted tail without replay", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "captured by cursor v2" }];
		const session = makeFakeSession(settings, entries);
		session.customEntries.push({
			id: "legacy-cursor",
			parentId: "message-0",
			timestamp: new Date(0).toISOString(),
			type: "custom",
			customType: "openviking-capture-cursor",
			data: {
				version: 2,
				identity: {
					baseUrl: baseConfig.baseUrl,
					credentialFingerprint: null,
					accountId: null,
					userId: null,
					peerId: null,
					sessionId: "omp-session-1",
				},
				capturedMessageCount: 1,
				committedUserTurns: 0,
				pendingCommit: true,
			},
		});
		const client = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, commitEveryNTurns: 1 },
			client,
			session: session as never,
		});

		await state.maybeRetainOnAgentEnd([]);

		expect(client.addMessage).not.toHaveBeenCalled();
		expect(client.commitSession).toHaveBeenCalledTimes(1);
		const latestCursor = session.customEntries.at(-1)?.data as { version?: number } | undefined;
		expect(latestCursor?.version).toBe(4);
	});

	it("migrates a v3 cursor and resumes its pending extraction", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "already archived" }];
		const session = makeFakeSession(settings, entries);
		session.customEntries.push({
			id: "cursor-v3",
			parentId: "message-0",
			timestamp: new Date(0).toISOString(),
			type: "custom",
			customType: "openviking-capture-cursor",
			data: {
				version: 3,
				identity: {
					baseUrl: baseConfig.baseUrl,
					credentialFingerprint: null,
					accountId: null,
					userId: null,
					peerId: null,
					sessionId: "omp-session-1",
				},
				capturedMessageCount: 1,
				archivedUserTurns: 1,
				hasUnarchivedRemoteMessages: false,
				pendingExtractions: [
					{
						taskId: "task-v3",
						archiveUri: "viking://session/omp-session-1/history/archive_001",
						acceptedAt: 0,
						throughMessageCount: 1,
						throughUserTurns: 1,
					},
				],
			},
		});
		const waitForCommitTask = vi.fn(async () => ({
			status: "completed" as const,
			task: {
				task_id: "task-v3",
				task_type: "session_commit",
				status: "completed" as const,
				resource_id: "omp-session-1",
				result: {
					archive_uri: "viking://session/omp-session-1/history/archive_001",
					memories_extracted: { preferences: 1 },
				},
			},
		}));
		const client = {
			baseUrl: baseConfig.baseUrl,
			addMessage: vi.fn(async () => ({ ok: true })),
			waitForCommitTask,
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		state.attachSessionListeners();

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const cursor = session.customEntries.at(-1)?.data as { version?: number; pendingExtractions?: unknown[] };
			if (cursor.version === 4 && cursor.pendingExtractions?.length === 0) break;
			await Bun.sleep(1);
		}
		expect(waitForCommitTask).toHaveBeenCalledTimes(1);
		expect(client.addMessage).not.toHaveBeenCalled();
		expect(session.customEntries.at(-1)?.data).toMatchObject({ version: 4, pendingExtractions: [] });
		await state.dispose({ flush: false });
	});

	it("does not reuse a cursor from another OpenViking tenant scope", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "tenant-scoped turn" }];
		const session = makeFakeSession(settings, entries);
		const firstClient = {
			baseUrl: "http://openviking.test",
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, accountId: "account-a", userId: "user-a" },
			client: firstClient,
			session: session as never,
		});
		await firstState.maybeRetainOnAgentEnd([]);

		const secondClient = {
			baseUrl: "http://openviking.test",
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const secondState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, accountId: "account-b", userId: "user-b" },
			client: secondClient,
			session: session as never,
		});
		await secondState.maybeRetainOnAgentEnd([]);

		expect(secondClient.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			content: "tenant-scoped turn",
		});
	});

	it("replays the transcript when the credential changes within the same apparent scope", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const entries = [{ role: "user" as const, content: "credential-scoped turn" }];
		const session = makeFakeSession(settings, entries);
		const firstClient = {
			baseUrl: "http://openviking.test",
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const firstState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, apiKey: "credential-a" },
			client: firstClient,
			session: session as never,
		});
		await firstState.maybeRetainOnAgentEnd([]);

		const secondClient = {
			baseUrl: "http://openviking.test",
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const secondState = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, apiKey: "credential-b" },
			client: secondClient,
			session: session as never,
		});
		await secondState.maybeRetainOnAgentEnd([]);

		expect(secondClient.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			content: "credential-scoped turn",
		});
		const persistedCursors = JSON.stringify(session.customEntries);
		expect(persistedCursors).not.toContain("credential-a");
		expect(persistedCursors).not.toContain("credential-b");
	});

	it("rejects an unsafe remote clear without detaching the active state", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "do not upload on clear" }]);
		const client = {
			addMessage: vi.fn(async () => ({ ok: true })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		setOpenVikingSessionState(session as never, state);

		await expect(openVikingBackend.clear("/tmp/agent", "/tmp/project", session as never)).rejects.toThrow(
			"OpenViking memory is server-side; /memory clear is not supported.",
		);

		expect(getOpenVikingSessionState(session as never)).toBe(state);
		expect(client.addMessage).not.toHaveBeenCalled();
		expect(client.commitSession).not.toHaveBeenCalled();
	});

	it("rejects enqueue when the current transcript tail cannot be captured", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "must not be reported as enqueued" }]);
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, status: 503, error: "unavailable" })),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});
		setOpenVikingSessionState(session as never, state);

		await expect(openVikingBackend.enqueue("/tmp/agent", "/tmp/project", session as never)).rejects.toThrow(
			"OpenViking could not capture and archive the current session tail.",
		);
	});

	it("keeps the current SessionManager when a transition tail flush fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "must survive failed transition", timestamp: 0 });
		const agent = new Agent({ initialState: { systemPrompt: ["test"], tools: [], messages: [] } });
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: {} as never });
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, error: "unavailable" })),
			commitSession: vi.fn(async () => commitAccepted()),
			ensureSession: vi.fn(async () => ({ ok: true })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: session.sessionId,
			config: baseConfig,
			client,
			session,
		});
		setOpenVikingSessionState(session, state);
		const originalSessionId = sessionManager.getSessionId();

		try {
			await expect(session.newSession()).resolves.toBe(false);
			expect(sessionManager.getSessionId()).toBe(originalSessionId);
			expect(client.ensureSession).not.toHaveBeenCalled();
		} finally {
			setOpenVikingSessionState(session, undefined);
			await state.dispose({ flush: false });
			await session.dispose();
		}
	});

	it("applies the recall score threshold to automatic and explicit searches", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const client = {
			search: vi.fn(async () => [
				{ uri: "viking://user/memories/low.md", score: 0.2, abstract: "low confidence" },
				{ uri: "viking://user/memories/high.md", score: 0.8, abstract: "high confidence" },
			]),
			readContent: vi.fn(),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: { ...baseConfig, scoreThreshold: 0.5 },
			client,
			session: session as never,
		});

		const recalled = await state.recallForContext("editor preference");
		const searched = await state.search("editor preference", 4);

		expect(recalled).toContain("high confidence");
		expect(recalled).not.toContain("low confidence");
		expect(searched.map(item => item.uri)).toEqual(["viking://user/memories/high.md"]);
	});

	it("clears stale recall when a later turn has no result, is too short, or disables auto-recall", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		let hasResult = true;
		const client = {
			search: vi.fn(async () =>
				hasResult ? [{ uri: "viking://user/memories/editor.md", score: 0.9, abstract: "use vim" }] : [],
			),
			readContent: vi.fn(),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await state.beforeAgentStartPrompt("remember my editor");
		expect(state.lastRecallSnippet).toContain("use vim");
		hasResult = false;
		await expect(state.beforeAgentStartPrompt("another editor question")).resolves.toBeUndefined();
		expect(state.lastRecallSnippet).toBeUndefined();

		state.lastRecallSnippet = "stale";
		await expect(state.beforeAgentStartPrompt("x")).resolves.toBeUndefined();
		expect(state.lastRecallSnippet).toBeUndefined();

		const disabled = new OpenVikingSessionState({
			sessionId: "session-2",
			config: { ...baseConfig, autoRecall: false },
			client,
			session: session as never,
		});
		disabled.lastRecallSnippet = "stale";
		await expect(disabled.beforeAgentStartPrompt("long enough question")).resolves.toBeUndefined();
		expect(disabled.lastRecallSnippet).toBeUndefined();
	});

	it("does not advertise OpenViking until session state is initialized", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);

		await expect(
			openVikingBackend.buildDeveloperInstructions?.("/tmp/agent", settings, session as never),
		).resolves.toBe(undefined);

		setOpenVikingSessionState(
			session as never,
			new OpenVikingSessionState({
				sessionId: "session-1",
				config: baseConfig,
				client: {} as OpenVikingApi,
				session: session as never,
			}),
		);
		await expect(
			openVikingBackend.buildDeveloperInstructions?.("/tmp/agent", settings, session as never),
		).resolves.toContain("OpenViking memory is active.");
	});

	it("leaves OpenViking API URL unset so external ovcli config can supply it", () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		expect(settings.get("openviking.apiUrl")).toBeUndefined();
	});

	it("uses OMP OpenViking settings before official config files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-config-"));
		try {
			const configPath = path.join(dir, "ov.conf");
			await Bun.write(
				configPath,
				JSON.stringify({
					claude_code: {
						autoCapture: false,
						recallLimit: 11,
						recallContextTurns: 5,
					},
				}),
			);
			const config = await loadOpenVikingConfig(
				Settings.isolated({
					"openviking.autoRetain": true,
					"openviking.recallLimit": 3,
					"openviking.recallContextTurns": 1,
				}),
				{
					OPENVIKING_CONFIG_FILE: configPath,
					OPENVIKING_CLI_CONFIG_FILE: MISSING_OPENVIKING_CONFIG,
				},
			);

			expect(config.autoRetain).toBe(true);
			expect(config.recallLimit).toBe(3);
			expect(config.recallContextTurns).toBe(1);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("sends peer_id in OpenViking message bodies", async () => {
		let body: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			_url: Parameters<typeof fetch>[0],
			init: Parameters<typeof fetch>[1],
		) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ status: "ok", result: {} });
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({ ...baseConfig, peerId: "peer-1" });

		await client.addMessage("session-1", { role: "user", content: "hello" });

		expect(body).toMatchObject({ role: "user", content: "hello", peer_id: "peer-1" });
	});

	it("captures new turns without retaining injected OpenViking blocks", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings);
		const added: Array<{ role: string; content: string }> = [];
		const client = {
			addMessage: vi.fn(async (_sessionId: string, payload: { role: string; content?: string }) => {
				added.push({ role: payload.role, content: payload.content ?? "" });
				return { ok: true };
			}),
			commitSession: vi.fn(async () => commitAccepted()),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await state.retainMessages([
			{
				role: "user",
				content: "remember my editor preference\n<openviking-context>old memory</openviking-context>",
			},
			{ role: "assistant", content: "Got it." },
		]);

		expect(added).toEqual([
			{ role: "user", content: "remember my editor preference" },
			{ role: "assistant", content: "Got it." },
		]);
	});
});
