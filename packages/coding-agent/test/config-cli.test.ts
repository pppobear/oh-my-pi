import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let testAgentDir: TempDir | undefined;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
const SECRET_ENV_KEYS = [
	"OPENVIKING_URL",
	"OPENVIKING_BASE_URL",
	"OPENVIKING_CONFIG_FILE",
	"OPENVIKING_CLI_CONFIG_FILE",
	"OPENVIKING_BEARER_TOKEN",
	"OPENVIKING_API_KEY",
	"OPENVIKING_ACCOUNT",
	"OPENVIKING_USER",
	"OMP_AUTH_BROKER_TOKEN",
	"HINDSIGHT_API_TOKEN",
	"MNEMOPI_EMBEDDING_API_KEY",
	"MNEMOPI_LLM_API_KEY",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
	"SEARXNG_TOKEN",
	"SEARXNG_BASIC_PASSWORD",
	"PI_AUTO_QA_PUSH_TOKEN",
] as const;

function isolateSecretEnvironment(): Disposable {
	const saved = new Map(SECRET_ENV_KEYS.map(key => [key, Bun.env[key]] as const));
	for (const key of SECRET_ENV_KEYS) delete Bun.env[key];
	Bun.env.OPENVIKING_CONFIG_FILE = "/tmp/omp-config-cli-missing-openviking.conf";
	Bun.env.OPENVIKING_CLI_CONFIG_FILE = "/tmp/omp-config-cli-missing-ovcli.conf";
	return {
		[Symbol.dispose]() {
			for (const [key, value] of saved) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		},
	};
}

beforeEach(() => {
	resetSettingsForTest();
	testAgentDir = TempDir.createSync("@omp-config-cli-");
	setAgentDir(testAgentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.resetInstance();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		try {
			await testAgentDir.remove();
		} catch {}
		testAgentDir = undefined;
	}
});

describe("config CLI schema coverage", () => {
	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("normalizes valid provider in-flight request limits from JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "providers.maxInFlightRequests",
			value: '{"openai":2.8,"anthropic":1}',
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "providers.maxInFlightRequests", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("providers.maxInFlightRequests");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ openai: 2, anthropic: 1 });
	});

	it("rejects invalid provider in-flight request limit entries", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "providers.maxInFlightRequests",
				value: '{"openai":"2","anthropic":0}',
				flags: { json: true },
			}),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Provider request limits must be positive numbers: openai, anthropic"),
		);
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("accepts max as a persisted default thinking level", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "set", key: "defaultThinkingLevel", value: "max", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "defaultThinkingLevel", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("defaultThinkingLevel");
		expect(parsed.type).toBe("enum");
		expect(parsed.value).toBe("max");
	});

	it("fully flushes JSON larger than a pipe buffer", async () => {
		if (!testAgentDir) throw new Error("Test agent directory was not initialized");
		const proc = Bun.spawn([process.execPath, cliEntry, "config", "list", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: testAgentDir.path(),
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);

		expect(exitCode).toBe(0);
		expect(error).toBe("");
		expect(Buffer.byteLength(output)).toBeGreaterThan(65_536);
		const parsed: unknown = JSON.parse(output);
		expect(parsed).toMatchObject({ modelRoles: { type: "record" } });
	});

	it("never prints configured secret values from text or JSON commands", async () => {
		using _environment = isolateSecretEnvironment();
		await initTheme();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, callback) => {
			if (typeof callback === "function") callback();
			return true;
		});
		const secret = "openviking-cli-secret-value";
		const outputs: string[] = [];
		const capture = async (command: Parameters<typeof runConfigCommand>[0]): Promise<string> => {
			logSpy.mockClear();
			stdoutSpy.mockClear();
			await runConfigCommand(command);
			const output = [
				logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n"),
				stdoutSpy.mock.calls.map(call => String(call[0] ?? "")).join(""),
			]
				.filter(Boolean)
				.join("\n");
			outputs.push(output);
			return output;
		};

		const textSet = Bun.stripANSI(
			await capture({ action: "set", key: "openviking.apiKey", value: secret, flags: {} }),
		);
		expect(textSet).toContain("Set openviking.apiKey = (configured)");

		const textGet = Bun.stripANSI(await capture({ action: "get", key: "openviking.apiKey", flags: {} }));
		expect(textGet).toBe("(configured)");

		const textList = Bun.stripANSI(await capture({ action: "list", flags: {} }));
		expect(textList).toContain("openviking.apiKey = (configured)");

		const textReset = Bun.stripANSI(await capture({ action: "reset", key: "openviking.apiKey", flags: {} }));
		expect(textReset).toContain("Reset openviking.apiKey to (not set)");

		const jsonSet = JSON.parse(
			await capture({ action: "set", key: "openviking.apiKey", value: secret, flags: { json: true } }),
		) as { key: string; value: unknown; configured?: boolean; redacted?: boolean };
		expect(jsonSet).toEqual({ key: "openviking.apiKey", value: null, configured: true, redacted: true });

		const jsonGet = JSON.parse(await capture({ action: "get", key: "openviking.apiKey", flags: { json: true } })) as {
			key: string;
			value: unknown;
			configured?: boolean;
			redacted?: boolean;
		};
		expect(jsonGet).toMatchObject({
			key: "openviking.apiKey",
			value: null,
			configured: true,
			redacted: true,
		});

		const jsonList = JSON.parse(await capture({ action: "list", flags: { json: true } })) as Record<
			string,
			{ value: unknown; configured?: boolean; redacted?: boolean }
		>;
		expect(jsonList["openviking.apiKey"]).toMatchObject({ value: null, configured: true, redacted: true });

		const jsonReset = JSON.parse(
			await capture({ action: "reset", key: "openviking.apiKey", flags: { json: true } }),
		) as Record<string, unknown>;
		expect(jsonReset).toEqual({
			key: "openviking.apiKey",
			value: null,
			configured: false,
			redacted: true,
		});

		Settings.instance.set("openviking.apiKey", "\r\n\t\x1b[31m\x07");
		const whitespaceText = Bun.stripANSI(await capture({ action: "get", key: "openviking.apiKey", flags: {} }));
		expect(whitespaceText).toBe("(not set)");
		const whitespaceJson = JSON.parse(
			await capture({ action: "get", key: "openviking.apiKey", flags: { json: true } }),
		) as Record<string, unknown>;
		expect(whitespaceJson).toMatchObject({ value: null, configured: false, redacted: true });

		const environmentSecret = "openviking-environment-secret-value";
		Bun.env.OPENVIKING_API_KEY = environmentSecret;
		const environmentText = Bun.stripANSI(await capture({ action: "get", key: "openviking.apiKey", flags: {} }));
		expect(environmentText).toBe("(configured)");
		const environmentJson = JSON.parse(
			await capture({ action: "get", key: "openviking.apiKey", flags: { json: true } }),
		) as Record<string, unknown>;
		expect(environmentJson).toMatchObject({ value: null, configured: true, redacted: true });
		delete Bun.env.OPENVIKING_API_KEY;
		Settings.instance.set("openviking.apiKey", undefined);

		const profileSecret = "openviking-profile-secret-value";
		const profilePath = path.join(testAgentDir!.path(), "ovcli.conf");
		await Bun.write(profilePath, JSON.stringify({ url: "https://openviking.test", api_key: profileSecret }));
		Bun.env.OPENVIKING_CLI_CONFIG_FILE = profilePath;
		const profileJson = JSON.parse(
			await capture({ action: "get", key: "openviking.apiKey", flags: { json: true } }),
		) as Record<string, unknown>;
		expect(profileJson).toMatchObject({ value: null, configured: true, redacted: true });

		const hiddenSecret = "hidden-auth-broker-secret-value";
		const hiddenJson = JSON.parse(
			await capture({ action: "set", key: "auth.broker.token", value: hiddenSecret, flags: { json: true } }),
		) as Record<string, unknown>;
		expect(hiddenJson).toEqual({
			key: "auth.broker.token",
			value: null,
			configured: true,
			redacted: true,
		});

		const hindsightSettingSecret = "hindsight-setting-secret-value";
		const hindsightSetJson = JSON.parse(
			await capture({
				action: "set",
				key: "hindsight.apiToken",
				value: hindsightSettingSecret,
				flags: { json: true },
			}),
		) as Record<string, unknown>;
		expect(hindsightSetJson).toEqual({
			key: "hindsight.apiToken",
			value: null,
			configured: true,
			redacted: true,
		});

		Settings.instance.set("hindsight.apiToken", undefined);
		const hindsightEnvironmentSecret = "hindsight-environment-secret-value";
		Bun.env.HINDSIGHT_API_TOKEN = hindsightEnvironmentSecret;
		const hindsightEnvironmentText = Bun.stripANSI(
			await capture({ action: "get", key: "hindsight.apiToken", flags: {} }),
		);
		expect(hindsightEnvironmentText).toBe("(configured)");
		const hindsightEnvironmentJson = JSON.parse(
			await capture({ action: "get", key: "hindsight.apiToken", flags: { json: true } }),
		) as Record<string, unknown>;
		expect(hindsightEnvironmentJson).toMatchObject({ value: null, configured: true, redacted: true });

		expect(outputs.join("\n")).not.toContain(secret);
		expect(outputs.join("\n")).not.toContain(environmentSecret);
		expect(outputs.join("\n")).not.toContain(profileSecret);
		expect(outputs.join("\n")).not.toContain(hiddenSecret);
		expect(outputs.join("\n")).not.toContain(hindsightSettingSecret);
		expect(outputs.join("\n")).not.toContain(hindsightEnvironmentSecret);
	});

	it("reports Mnemopi secrets configured through their runtime environment fallbacks", async () => {
		using _environment = isolateSecretEnvironment();
		await initTheme();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const outputs: string[] = [];
		const getText = async (key: "mnemopi.embeddingApiKey" | "mnemopi.llmApiKey"): Promise<string> => {
			logSpy.mockClear();
			await runConfigCommand({ action: "get", key, flags: {} });
			const output = logSpy.mock.calls.map(call => String(call[0] ?? "")).join("\n");
			outputs.push(output);
			return Bun.stripANSI(output);
		};

		for (const name of ["MNEMOPI_EMBEDDING_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"] as const) {
			Bun.env[name] = `${name.toLowerCase()}-secret`;
			expect(await getText("mnemopi.embeddingApiKey")).toBe("(configured)");
			delete Bun.env[name];
		}

		Bun.env.MNEMOPI_LLM_API_KEY = "mnemopi-llm-secret";
		expect(await getText("mnemopi.llmApiKey")).toBe("(configured)");
		expect(outputs.join("\n")).not.toContain("secret");
	});
});
