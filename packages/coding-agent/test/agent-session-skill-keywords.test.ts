import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for #2126: skill invocations dispatch through
 * `promptCustomMessage`, which used to bypass the magic-keyword scan that
 * `prompt()` runs on user input — so a highlighted `workflowz`/`orchestrate`/
 * `ultrathink`/`+Nk` typed inside `/skill:<name> …` looked active but never
 * injected its hidden system notice. The fix threads `keywordText` through
 * `promptCustomMessage`; both skill dispatch sites (interactive +
 * ACP) now pass the trimmed args.
 */

type Harness = { session: AgentSession; authStorage: AuthStorage; tempDir: TempDir };
const harnesses: Harness[] = [];

async function createHarness(responses: MockResponse[]): Promise<AgentSession> {
	const tempDir = TempDir.createSync("@pi-skill-keywords-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(),
	});

	harnesses.push({ session, authStorage, tempDir });
	return session;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) {
		await h.session.dispose();
		h.authStorage.close();
		h.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

const SKILL_BODY = "Skill body. No keywords here.\n\n---\n\nSkill: /tmp/dummy.md";
const SKILL_DETAILS = { name: "dummy", path: "/tmp/dummy.md", lineCount: 1 };

describe("AgentSession skill keyword wiring (#2126)", () => {
	it("injects the matching notices when keywordText carries magic keywords", async () => {
		const session = await createHarness([{ content: ["done"], stopReason: "stop" }]);

		await session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: `${SKILL_BODY}\nUser: workflowz and orchestrate`,
				display: true,
				details: SKILL_DETAILS,
				attribution: "user",
			},
			{ keywordText: "workflowz and orchestrate" },
		);
		await session.waitForIdle();

		const customTypes = session.agent.state.messages
			.filter((m): m is Extract<AgentMessage, { role: "custom" }> => m.role === "custom")
			.map(m => m.customType);

		expect(customTypes).toContain("orchestrate-notice");
		expect(customTypes).toContain("workflow-notice");
		expect(customTypes).not.toContain("ultrathink-notice");
	});

	it("starts the +Nk turn budget parsed out of keywordText", async () => {
		const session = await createHarness([{ content: ["ack"], stopReason: "stop" }]);

		await session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: `${SKILL_BODY}\nUser: compare these +500k`,
				display: true,
				details: SKILL_DETAILS,
				attribution: "user",
			},
			{ keywordText: "compare these +500k" },
		);
		await session.waitForIdle();

		const budget = session.sessionManager.getTurnBudget();
		expect(budget.total).toBe(500_000);
		expect(budget.hard).toBe(false);
	});

	it("ignores keywords that appear only in the skill body, not in keywordText", async () => {
		// Skill author's prose mentioning a keyword is NOT user intent.
		// `keywordText` is the user-typed args only; the body should never trigger.
		const session = await createHarness([{ content: ["ack"], stopReason: "stop" }]);

		await session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "Skill body mentions orchestrate and workflowz inline.\n\n---\n\nSkill: /tmp/dummy.md",
				display: true,
				details: SKILL_DETAILS,
				attribution: "user",
			},
			{ keywordText: "" },
		);
		await session.waitForIdle();

		const customTypes = session.agent.state.messages
			.filter((m): m is Extract<AgentMessage, { role: "custom" }> => m.role === "custom")
			.map(m => m.customType);
		expect(customTypes).not.toContain("orchestrate-notice");
		expect(customTypes).not.toContain("workflow-notice");
	});

	it("stays back-compat: no keywordText means no scan and no notices", async () => {
		const session = await createHarness([{ content: ["ack"], stopReason: "stop" }]);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Plain custom message; pretend workflowz is in the args.",
			display: true,
			details: SKILL_DETAILS,
			attribution: "user",
		});
		await session.waitForIdle();

		const customTypes = session.agent.state.messages
			.filter((m): m is Extract<AgentMessage, { role: "custom" }> => m.role === "custom")
			.map(m => m.customType);
		expect(customTypes).not.toContain("orchestrate-notice");
		expect(customTypes).not.toContain("workflow-notice");
		expect(customTypes).not.toContain("ultrathink-notice");
		expect(session.sessionManager.getTurnBudget().total).toBeNull();
	});
});
