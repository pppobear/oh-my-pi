import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	deriveOpenVikingWorkspacePeerId,
	getOpenVikingEnvironmentVariable,
	loadOpenVikingConfig,
} from "@oh-my-pi/pi-coding-agent/openviking/config";

async function writeProfile(dir: string, name: string, value: unknown): Promise<string> {
	const filePath = path.join(dir, name);
	await Bun.write(filePath, JSON.stringify(value));
	return filePath;
}

describe("OpenViking configuration profiles", () => {
	it("accepts an ovcli profile through the legacy OPENVIKING_CONFIG_FILE variable", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const cliPath = await writeProfile(dir, "custom-ovcli.conf", {
				url: "https://compat.openviking.test/",
				api_key: "compat-cli-secret",
				account_id: "compat-account",
				user_id: "compat-user",
				actor_peer_id: "compat-peer",
			});

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: cliPath,
			});

			expect(config).toMatchObject({
				baseUrl: "https://compat.openviking.test",
				apiKey: "compat-cli-secret",
				accountId: "compat-account",
				userId: "compat-user",
				peerId: "compat-peer",
				peerSource: "explicit",
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not combine an ovcli URL with credentials from legacy ov.conf", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { url: "http://127.0.0.1:1933", root_api_key: "legacy-root-secret" },
				claude_code: {
					apiKey: "legacy-client-secret",
					accountId: "legacy-account",
					userId: "legacy-user",
					peerId: "legacy-peer",
				},
			});
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://remote.openviking.test/",
				account: "remote-account",
				user: "remote-user",
			});

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});

			expect(config.baseUrl).toBe("https://remote.openviking.test");
			expect(config.apiKey).toBeNull();
			expect(config.accountId).toBe("remote-account");
			expect(config.userId).toBe("remote-user");
			expect(config.peerId).toBe(deriveOpenVikingWorkspacePeerId(Settings.isolated().getCwd()));
			expect(config.peerSource).toBe("workspace");
			expect(config.workspacePeer).toBe(true);

			await Bun.write(
				cliPath,
				JSON.stringify({
					url: "https://remote.openviking.test/",
					api_key: "remote-cli-secret",
					account: "remote-account",
					user: "remote-user",
				}),
			);
			const authenticated = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});
			expect(authenticated.apiKey).toBe("remote-cli-secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps legacy server credentials bound to the legacy server profile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { host: "0.0.0.0", port: 2048, root_api_key: "legacy-root-secret" },
				claude_code: { accountId: "legacy-account", userId: "legacy-user", peerId: "legacy-peer" },
			});

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: path.join(dir, "missing-ovcli.conf"),
			});

			expect(config).toMatchObject({
				baseUrl: "http://127.0.0.1:2048",
				apiKey: "legacy-root-secret",
				accountId: "legacy-account",
				userId: "legacy-user",
				peerId: "legacy-peer",
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reads current ovcli identity aliases even when the default URL is omitted", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { url: "https://legacy.openviking.test", root_api_key: "legacy-secret" },
				codex: { peerId: "legacy-peer" },
			});
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				api_key: "cli-secret",
				account_id: "cli-account",
				user_id: "cli-user",
				actor_peer_id: "cli-peer",
			});

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});

			expect(config).toMatchObject({
				baseUrl: "https://legacy.openviking.test",
				apiKey: "cli-secret",
				accountId: "cli-account",
				userId: "cli-user",
				peerId: "cli-peer",
				peerSource: "explicit",
			});

			await Bun.write(cliPath, JSON.stringify({ api_key: "cli-secret", peer_id: "compat-peer" }));
			const compatible = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});
			expect(compatible.peerId).toBe("compat-peer");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("honors the official credential source selectors", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { url: "https://legacy.openviking.test", root_api_key: "legacy-secret" },
			});
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://cli.openviking.test",
				api_key: "cli-secret",
				account_id: "cli-account",
				user_id: "cli-user",
				actor_peer_id: "cli-peer",
			});
			const paths = {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			};

			const forcedCli = await loadOpenVikingConfig(Settings.isolated(), {
				...paths,
				OPENVIKING_CREDENTIAL_SOURCE: "cli",
				OPENVIKING_URL: "https://stale-env.openviking.test",
				OPENVIKING_API_KEY: "stale-env-secret",
				OPENVIKING_ACCOUNT: "stale-account",
				OPENVIKING_USER: "stale-user",
				OPENVIKING_PEER_ID: "stale-peer",
			});
			expect(forcedCli).toMatchObject({
				baseUrl: "https://cli.openviking.test",
				apiKey: "cli-secret",
				accountId: "cli-account",
				userId: "cli-user",
				peerId: "cli-peer",
			});

			const forcedEnvironment = await loadOpenVikingConfig(Settings.isolated(), {
				...paths,
				OPENVIKING_CREDENTIALS_SOURCE: "environment",
				OPENVIKING_API_KEY: "environment-secret",
			});
			expect(forcedEnvironment.baseUrl).toBe("https://legacy.openviking.test");
			expect(forcedEnvironment.apiKey).toBe("environment-secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps ovcli identity fallback in environment credential mode without ov.conf", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://ignored-cli.openviking.test",
				api_key: "cli-fallback-secret",
				account_id: "cli-fallback-account",
				user_id: "cli-fallback-user",
				actor_peer_id: "cli-fallback-peer",
			});

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: path.join(dir, "missing-ov.conf"),
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
				OPENVIKING_CREDENTIAL_SOURCE: "env",
			});

			expect(config).toMatchObject({
				baseUrl: "http://127.0.0.1:1933",
				apiKey: "cli-fallback-secret",
				accountId: "cli-fallback-account",
				userId: "cli-fallback-user",
				peerId: "cli-fallback-peer",
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not promote a legacy ovcli agent_id into the workspace peer", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				api_key: "cli-secret",
				agent_id: "legacy-agent",
			});
			const settings = Settings.isolated();
			const config = await loadOpenVikingConfig(settings, {
				OPENVIKING_CONFIG_FILE: path.join(dir, "missing-ov.conf"),
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});

			expect(config.apiKey).toBe("cli-secret");
			expect(config.peerId).toBe(deriveOpenVikingWorkspacePeerId(settings.getCwd()));
			expect(config.peerSource).toBe("workspace");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("reads current codex tuning and legacy peer aliases from ov.conf", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { url: "http://127.0.0.1:1933" },
				claude_code: { autoRecall: true, peerId: "old-peer" },
				codex: { autoRecall: false, peer_id: "codex-peer" },
			});
			const missingCli = path.join(dir, "missing-ovcli.conf");

			const config = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: missingCli,
			});
			expect(config.peerId).toBe("codex-peer");
			expect(config.peerSource).toBe("explicit");
			expect(config.autoRecall).toBe(false);

			await Bun.write(
				legacyPath,
				JSON.stringify({ server: { url: "http://127.0.0.1:1933" }, codex: { workspacePeer: false } }),
			);
			const optedOut = await loadOpenVikingConfig(Settings.isolated(), {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: missingCli,
			});
			expect(optedOut.peerId).toBeNull();
			expect(optedOut.peerSource).toBe("none");
			expect(optedOut.workspacePeer).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("allows explicit settings and environment credentials to override discovered profiles", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const legacyPath = await writeProfile(dir, "ov.conf", {
				server: { url: "http://legacy.openviking.test", root_api_key: "legacy-root-secret" },
			});
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://cli.openviking.test",
				api_key: "cli-secret",
			});
			const settings = Settings.isolated({
				"openviking.apiUrl": "https://settings.openviking.test/",
				"openviking.apiKey": "settings-secret",
			});

			const fromSettings = await loadOpenVikingConfig(settings, {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
			});
			expect(fromSettings.baseUrl).toBe("https://settings.openviking.test");
			expect(fromSettings.apiKey).toBe("settings-secret");

			const fromEnvironment = await loadOpenVikingConfig(settings, {
				OPENVIKING_CONFIG_FILE: legacyPath,
				OPENVIKING_CLI_CONFIG_FILE: cliPath,
				OPENVIKING_URL: "https://env.openviking.test/",
				OPENVIKING_API_KEY: "env-secret",
			});
			expect(fromEnvironment.baseUrl).toBe("https://env.openviking.test");
			expect(fromEnvironment.apiKey).toBe("env-secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not borrow discovered credentials for an explicit URL without an explicit key", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://cli.openviking.test",
				api_key: "cli-secret",
			});
			const config = await loadOpenVikingConfig(
				Settings.isolated({ "openviking.apiUrl": "https://explicit.openviking.test" }),
				{
					OPENVIKING_CONFIG_FILE: path.join(dir, "missing-ov.conf"),
					OPENVIKING_CLI_CONFIG_FILE: cliPath,
				},
			);

			expect(config.baseUrl).toBe("https://explicit.openviking.test");
			expect(config.apiKey).toBeNull();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a discovered credential when an explicit URL still names the same profile", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-openviking-profile-"));
		try {
			const cliPath = await writeProfile(dir, "ovcli.conf", {
				url: "https://cli.openviking.test/",
				api_key: "cli-secret",
			});
			const config = await loadOpenVikingConfig(
				Settings.isolated({ "openviking.apiUrl": "https://cli.openviking.test" }),
				{
					OPENVIKING_CONFIG_FILE: path.join(dir, "missing-ov.conf"),
					OPENVIKING_CLI_CONFIG_FILE: cliPath,
				},
			);

			expect(config.baseUrl).toBe("https://cli.openviking.test");
			expect(config.apiKey).toBe("cli-secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores invalid boolean environment values in config resolution and provenance", async () => {
		const env = {
			OPENVIKING_AUTO_RECALL: "invalid",
			OPENVIKING_CONFIG_FILE: "/tmp/omp-openviking-invalid-env-missing.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-openviking-invalid-env-missing-cli.conf",
		};
		const config = await loadOpenVikingConfig(Settings.isolated({ "openviking.autoRecall": false }), env);

		expect(config.autoRecall).toBe(false);
		expect(getOpenVikingEnvironmentVariable("openviking.autoRecall", env)).toBeUndefined();
	});

	it("does not report ignored environment credentials when CLI credential mode is selected", () => {
		const env = {
			OPENVIKING_CREDENTIAL_SOURCE: "cli",
			OPENVIKING_URL: "https://ignored.openviking.test",
			OPENVIKING_API_KEY: "ignored-secret",
			OPENVIKING_ACCOUNT: "ignored-account",
			OPENVIKING_USER: "ignored-user",
			OPENVIKING_PEER_ID: "ignored-peer",
			OPENVIKING_AUTO_RECALL: "false",
		};

		for (const path of [
			"openviking.apiUrl",
			"openviking.apiKey",
			"openviking.account",
			"openviking.user",
			"openviking.peerId",
		] as const) {
			expect(getOpenVikingEnvironmentVariable(path, env)).toBeUndefined();
		}
		expect(getOpenVikingEnvironmentVariable("openviking.autoRecall", env)).toBe("OPENVIKING_AUTO_RECALL");
		expect(
			getOpenVikingEnvironmentVariable("openviking.apiKey", {
				...env,
				OPENVIKING_CREDENTIAL_SOURCE: "env",
			}),
		).toBe("OPENVIKING_API_KEY");
	});

	it("derives a workspace peer by default and supports explicit override or opt-out", async () => {
		const settings = Settings.isolated();
		const missingProfiles = {
			OPENVIKING_CONFIG_FILE: "/tmp/omp-openviking-workspace-peer-missing.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-openviking-workspace-peer-missing-cli.conf",
		};

		const readablePeer = deriveOpenVikingWorkspacePeerId(path.join(os.tmpdir(), "Dev", "OpenViking"));
		expect(readablePeer).toMatch(/^omp-ws-v1-openviking-[a-f0-9]{20}$/);
		expect(deriveOpenVikingWorkspacePeerId(path.join(os.tmpdir(), "Dev", "OpenViking"))).toBe(readablePeer);
		expect(deriveOpenVikingWorkspacePeerId("/tmp/foo/bar")).not.toBe(deriveOpenVikingWorkspacePeerId("/tmp/foo-bar"));
		expect(deriveOpenVikingWorkspacePeerId("/tmp/foo/../foo/bar")).toBe(
			deriveOpenVikingWorkspacePeerId("/tmp/foo/bar"),
		);
		expect((await loadOpenVikingConfig(settings, missingProfiles)).peerId).toBe(
			deriveOpenVikingWorkspacePeerId(settings.getCwd()),
		);
		expect(
			(await loadOpenVikingConfig(settings, { ...missingProfiles, OPENVIKING_PEER_ID: "explicit-peer" })).peerId,
		).toBe("explicit-peer");
		expect(
			(await loadOpenVikingConfig(settings, { ...missingProfiles, OPENVIKING_WORKSPACE_PEER: "0" })).peerId,
		).toBeNull();
		expect(
			(await loadOpenVikingConfig(settings, { ...missingProfiles, OPENVIKING_WORKSPACE_PEER: "0" })).workspacePeer,
		).toBe(false);
		expect(
			(await loadOpenVikingConfig(settings, { ...missingProfiles, OPENVIKING_WORKSPACE_PEER: "off" })).workspacePeer,
		).toBe(false);
		expect(
			(await loadOpenVikingConfig(settings, { ...missingProfiles, OPENVIKING_WORKSPACE_PEER: "on" })).workspacePeer,
		).toBe(true);
	});

	it("defaults recall to the actor peer and accepts an explicit all-peer scope", async () => {
		const missingProfiles = {
			OPENVIKING_CONFIG_FILE: "/tmp/omp-openviking-recall-scope-missing.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-openviking-recall-scope-missing-cli.conf",
		};

		expect((await loadOpenVikingConfig(Settings.isolated(), missingProfiles)).recallPeerScope).toBe("actor");
		expect(
			(
				await loadOpenVikingConfig(Settings.isolated(), {
					...missingProfiles,
					OPENVIKING_RECALL_PEER_SCOPE: "all",
				})
			).recallPeerScope,
		).toBe("all");
		expect(
			getOpenVikingEnvironmentVariable("openviking.recallPeerScope", {
				OPENVIKING_RECALL_PEER_SCOPE: "invalid",
			}),
		).toBeUndefined();
	});
});
