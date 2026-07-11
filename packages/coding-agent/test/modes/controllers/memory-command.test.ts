import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

describe("CommandController /memory", () => {
	it("reports unsupported OpenViking clear without detaching or refreshing the prompt", async () => {
		const settings = Settings.isolated({ "memory.backend": "openviking" });
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const showError = vi.fn();
		const showStatus = vi.fn();
		const controller = new CommandController({
			settings,
			session: {
				waitForMemoryBackendReconcile: async () => {},
				refreshBaseSystemPrompt,
			},
			sessionManager: { getCwd: () => "/tmp/project" },
			showError,
			showStatus,
		} as unknown as InteractiveModeContext);

		await controller.handleMemoryCommand("/memory clear");

		expect(showError).toHaveBeenCalledWith(
			"Memory clear failed: OpenViking memory is server-side; /memory clear is not supported. Delete specific memory resources in OpenViking instead.",
		);
		expect(refreshBaseSystemPrompt).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
	});
});
