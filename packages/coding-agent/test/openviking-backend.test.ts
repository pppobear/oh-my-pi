import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createMemoryRuntimeContext, resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { openVikingBackend } from "@oh-my-pi/pi-coding-agent/openviking/backend";
import { OpenVikingApi } from "@oh-my-pi/pi-coding-agent/openviking/client";
import { loadOpenVikingConfig, type OpenVikingConfig } from "@oh-my-pi/pi-coding-agent/openviking/config";
import { OpenVikingSessionState, setOpenVikingSessionState } from "@oh-my-pi/pi-coding-agent/openviking/state";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
	const session = {
		sessionId: "session-1",
		settings,
		sessionManager: {
			getEntries: () => entries.map(entry => ({ type: "message", message: entry })),
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const listener of listeners) listener(event);
		},
	} as never;
	return session as {
		sessionId: string;
		settings: Settings;
		emit(event: Parameters<AgentSessionEventListener>[0]): void;
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
			commitSession: vi.fn(async () => ({ ok: true })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await expect(state.save("remember this", "manual")).resolves.toBe(true);
		expect(client.addMessage).toHaveBeenCalledWith("omp-session-1", {
			role: "user",
			content: "remember this\n\nContext: manual",
		});
		expect(client.commitSession).toHaveBeenCalledWith("omp-session-1");
	});

	it("does not advance auto-capture counters when OpenViking writes fail", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const session = makeFakeSession(settings, [{ role: "user", content: "turn one" }]);
		const client = {
			addMessage: vi.fn(async () => ({ ok: false, error: "down" })),
			commitSession: vi.fn(async () => ({ ok: true })),
		} as unknown as OpenVikingApi;
		const state = new OpenVikingSessionState({
			sessionId: "session-1",
			config: baseConfig,
			client,
			session: session as never,
		});

		await state.maybeRetainOnAgentEnd([]);
		expect(state.lastCapturedMessageCount).toBe(0);
		expect(client.commitSession).not.toHaveBeenCalled();
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
			commitSession: vi.fn(async () => ({ ok: true })),
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
