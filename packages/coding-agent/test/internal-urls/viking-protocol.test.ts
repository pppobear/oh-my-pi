import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

const OPENVIKING_ENV_KEYS = [
	"OPENVIKING_URL",
	"OPENVIKING_BASE_URL",
	"OPENVIKING_CONFIG_FILE",
	"OPENVIKING_CLI_CONFIG_FILE",
	"OPENVIKING_BEARER_TOKEN",
	"OPENVIKING_API_KEY",
	"OPENVIKING_ACCOUNT",
	"OPENVIKING_USER",
] as const;
const savedOpenVikingEnv: Partial<Record<(typeof OPENVIKING_ENV_KEYS)[number], string>> = {};
const MISSING_OPENVIKING_CONFIG = "/tmp/omp-openviking-viking-protocol-missing.conf";

describe("VikingProtocolHandler", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
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
		InternalUrlRouter.resetForTests();
		for (const key of OPENVIKING_ENV_KEYS) {
			if (savedOpenVikingEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedOpenVikingEnv[key];
		}
	});

	it("registers viking URLs as readable internal resources", async () => {
		const router = InternalUrlRouter.instance();
		expect(router.canHandle("viking://user/memories/entities/network.md")).toBe(true);
	});

	it("reads OpenViking content through caller settings", async () => {
		let requested: URL | undefined;
		let authorization: string | null = null;
		let account: string | null = null;
		let user: string | null = null;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			url: Parameters<typeof fetch>[0],
			init: Parameters<typeof fetch>[1],
		) => {
			requested = new URL(String(url));
			const headers = new Headers(init?.headers);
			authorization = headers.get("Authorization");
			account = headers.get("X-OpenViking-Account");
			user = headers.get("X-OpenViking-User");
			return Response.json({ status: "ok", result: "# Network\n- router" });
		}) as unknown as typeof fetch);
		const settings = Settings.isolated({
			"openviking.apiUrl": "http://openviking.test",
			"openviking.apiKey": "test-key",
			"openviking.account": "main",
			"openviking.user": "enoch",
		});
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("viking://user/enoch/memories/entities/%E7%BD%91%E7%BB%9C.md", {
			settings,
		});

		expect(requested?.origin).toBe("http://openviking.test");
		expect(requested?.pathname).toBe("/api/v1/content/read");
		expect(requested?.searchParams.get("uri")).toBe("viking://user/enoch/memories/entities/网络.md");
		expect(authorization ?? "").toBe("Bearer test-key");
		expect(account ?? "").toBe("main");
		expect(user ?? "").toBe("enoch");
		expect(resource).toMatchObject({
			url: "viking://user/enoch/memories/entities/网络.md",
			content: "# Network\n- router",
			contentType: "text/markdown",
			immutable: true,
		});
		expect(resource.notes).toEqual(["OpenViking content"]);
	});

	it("surfaces unavailable OpenViking content as a read error", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
			return Response.json({ status: "error", error: { message: "not found" } }, { status: 404 });
		}) as unknown as typeof fetch);
		const settings = Settings.isolated({ "openviking.apiUrl": "http://openviking.test" });
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("viking://user/memories/missing.md", { settings })).rejects.toThrow(
			"OpenViking content not found or unavailable",
		);
	});
});
