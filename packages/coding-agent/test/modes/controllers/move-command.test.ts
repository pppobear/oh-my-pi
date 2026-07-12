import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMoveContext(sourceDir: string) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined };
	const present = vi.fn();
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
	});
	const ctx = {
		session: {
			isStreaming: false,
			suspendMemoryBackendForWorkspaceTransition: vi.fn(async () => undefined),
		},
		sessionManager: {
			getCwd: () => state.cwd,
			moveTo: vi.fn(async (cwd: string) => {
				state.cwd = cwd;
				state.movedTo = cwd;
			}),
			dropSession: vi.fn(async () => {}),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("keeps the memory backend active when moving to the current cwd is a no-op", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(sourceDir);

			expect(ctx.session.suspendMemoryBackendForWorkspaceTransition).not.toHaveBeenCalled();
			expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
			expect(ctx.showStatus).toHaveBeenCalledWith(`Already in ${sourceDir}.`);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it("cancels the move before relocating when memory suspension fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			vi.spyOn(ctx.session, "suspendMemoryBackendForWorkspaceTransition").mockRejectedValueOnce(
				new Error("source tail unavailable"),
			);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith("Move cancelled: source tail unavailable");
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("keeps memory inert when moveTo fails after changing the session cwd", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const complete = vi.fn(async () => {});
			vi.spyOn(ctx.session, "suspendMemoryBackendForWorkspaceTransition").mockResolvedValueOnce({ complete });
			vi.spyOn(ctx.sessionManager, "moveTo").mockImplementationOnce(async cwd => {
				state.cwd = cwd;
				throw new Error("rewrite failed");
			});
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(complete).toHaveBeenCalledWith({ restart: false });
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(ctx.showError).toHaveBeenCalledWith("Move partially applied; memory remains inactive: rewrite failed");
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("releases the memory transition when destination cwd application throws", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx } = createMoveContext(sourceDir);
			const complete = vi.fn(async () => {});
			vi.spyOn(ctx.session, "suspendMemoryBackendForWorkspaceTransition").mockResolvedValueOnce({ complete });
			vi.spyOn(ctx, "applyCwdChange").mockRejectedValueOnce(new Error("chdir failed"));
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(complete).toHaveBeenCalledWith({ restart: false });
			expect(ctx.showError).toHaveBeenCalledWith(
				`Session moved to ${targetDir}, but destination settings could not be loaded; memory remains inactive: chdir failed`,
			);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
