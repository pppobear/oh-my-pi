import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getOpenVikingEnvironmentVariable, loadOpenVikingConfig } from "@oh-my-pi/pi-coding-agent/openviking/config";

async function writeProfile(dir: string, name: string, value: unknown): Promise<string> {
	const filePath = path.join(dir, name);
	await Bun.write(filePath, JSON.stringify(value));
	return filePath;
}

describe("OpenViking configuration profiles", () => {
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
			expect(config.peerId).toBeNull();

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
});
