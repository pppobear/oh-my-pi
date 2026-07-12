import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	resetSettingsForTest();
});

describe("InteractiveMode cwd memory reconciliation", () => {
	it("reloads destination settings before rebuilding the memory backend", async () => {
		const originalCwd = getProjectDir();
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interactive-cwd-"));
		await Settings.init({ cwd: originalCwd, inMemory: true });
		const reconcileMemoryBackend = vi.fn(async () => {
			expect(settings.getCwd()).toBe(targetDir);
		});
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			session: {
				reconcileMemoryBackend,
				refreshSshTool: vi.fn(async () => {}),
			},
			sessionManager: {
				getSessionName: () => undefined,
				getCwd: () => targetDir,
			},
			refreshTitleSystemPrompt: vi.fn(async () => {}),
			refreshSlashCommandState: vi.fn(async () => {}),
			statusLine: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
		}) as InteractiveMode;

		try {
			await mode.applyCwdChange(targetDir);

			expect(reconcileMemoryBackend).toHaveBeenCalledTimes(1);
			expect(mode.refreshTitleSystemPrompt).toHaveBeenCalledWith(targetDir);
			expect(mode.refreshSlashCommandState).toHaveBeenCalledWith(targetDir);
		} finally {
			setProjectDir(originalCwd);
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
