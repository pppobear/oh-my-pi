import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { loadOpenVikingConfig } from "@oh-my-pi/pi-coding-agent/openviking/config";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(onCancel: () => void = () => {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: () => {},
			onCancel,
		},
	);
}

/** Switch the selector to the memory tab. SETTING_TABS puts memory at index 4 (after appearance/model/interaction/context). */
function focusMemoryTab(comp: SettingsSelectorComponent): void {
	for (let i = 0; i < 4; i++) {
		comp.handleInput("\x1b[C");
	}
}

function replaceEnvironment(values: Record<string, string | undefined>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function renderPlain(comp: SettingsSelectorComponent, width = 140): string {
	return comp
		.render(width)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
}

async function waitForRender(
	comp: SettingsSelectorComponent,
	predicate: (rendered: string) => boolean,
): Promise<string> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const rendered = renderPlain(comp);
		if (predicate(rendered)) return rendered;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for settings render:\n${renderPlain(comp)}`);
}

function selectSearchResultByDescription(comp: SettingsSelectorComponent, description: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		if (renderPlain(comp).includes(description)) return;
		comp.handleInput("\x1b[A");
	}
	throw new Error(`Could not select settings result described by ${description}`);
}

describe("SettingsSelectorComponent memory tab", () => {
	it("reveals condition-gated Hindsight rows the moment memory.backend changes via the submenu", () => {
		settings.set("memory.backend", "off");
		const comp = createSelector();
		focusMemoryTab(comp);
		// Width 70 keeps the flat single-column layout (the wide split layout
		// shows only the active section's rows, covered by the sidebar test).
		const before = comp.render(70).join("\n");
		expect(before).toContain("Memory Backend");
		expect(before).not.toContain("Hindsight API URL");

		// Memory Backend is the only visible row, so it's already selected at index 0.
		// Enter opens the SelectSubmenu pre-positioned on "off"; navigate to "hindsight" (index 2) and confirm.
		comp.handleInput("\n");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("hindsight");
		const after = comp.render(70).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).toContain("Hindsight API URL");
		expect(after).toContain("Hindsight Auto Recall");
	});

	it("hides Hindsight rows again when the backend is switched back to off without leaving the tab", () => {
		settings.set("memory.backend", "hindsight");
		const comp = createSelector();
		focusMemoryTab(comp);
		// Width 70 keeps the flat layout so all sections' rows render inline.
		expect(comp.render(70).join("\n")).toContain("Hindsight API URL");

		// Open Memory Backend → SelectSubmenu pre-selects the current value
		// ("hindsight" at index 2) → step up twice to reach "off" → Enter confirms.
		comp.handleInput("\n");
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[A");
		comp.handleInput("\n");

		expect(settings.get("memory.backend")).toBe("off");
		const after = comp.render(70).join("\n");
		expect(after).toContain("Memory Backend");
		expect(after).not.toContain("Hindsight API URL");
		expect(after).not.toContain("Hindsight Auto Recall");
	});

	it("clears the global settings search on Escape before closing the selector", () => {
		let cancelCount = 0;
		const comp = createSelector(() => {
			cancelCount++;
		});

		// Typing starts the cross-tab search: banner shows the query and matches.
		comp.handleInput("b");
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const searching = comp.render(120).map(strip).join("\n");
		const banner =
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ match/.test(line)) ?? "";
		expect(banner).toContain(" b ");
		expect(searching).toMatch(/\d+ match/);

		// First Escape exits search mode without closing the panel.
		comp.handleInput("\x1b");
		expect(cancelCount).toBe(0);
		expect(comp.render(120).join("\n")).not.toContain("matches");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("puts the exact global settings search hit before incidental matches", () => {
		const comp = createSelector();
		for (const ch of "image provider") comp.handleInput(ch);

		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const rendered = comp.render(120).map(strip).join("\n");
		const providersIndex = rendered.indexOf("Providers");
		const appearanceIndex = rendered.indexOf("Appearance");

		expect(rendered).toContain("Image Provider");
		expect(rendered).not.toContain("Include Model in Prompt");
		expect(rendered).not.toContain("Service Tier");
		expect(providersIndex).toBeGreaterThanOrEqual(0);
		if (appearanceIndex >= 0) {
			expect(appearanceIndex).toBeGreaterThan(providersIndex);
		}
	});

	it("supports editor hotkeys in the global search bar", () => {
		const comp = createSelector();
		const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
		const banner = (): string =>
			comp
				.render(120)
				.map(strip)
				.find(line => /\d+ match/.test(line)) ?? "";

		// alt+backspace deletes the trailing word from the query.
		for (const ch of "image provider") comp.handleInput(ch);
		comp.handleInput("\x1b\x7f");
		expect(banner()).toContain("image");
		expect(banner()).not.toContain("provider");

		// Arrow keys move the cursor; typing inserts mid-query instead of appending.
		comp.handleInput("\x15"); // ctrl+u clears the rest of the query
		for (const ch of "model") comp.handleInput(ch);
		for (let i = 0; i < 5; i++) comp.handleInput("\x1b[D");
		comp.handleInput("x");
		expect(banner()).toContain("xmodel");
	});

	it("delegates Escape to an open settings submenu before closing the selector", () => {
		let cancelCount = 0;
		settings.set("memory.backend", "off");
		const comp = createSelector(() => {
			cancelCount++;
		});
		focusMemoryTab(comp);

		comp.handleInput("\n");
		expect(comp.render(120).join("\n")).toContain("Esc to go back");

		comp.handleInput("\x1b");
		const afterBack = comp.render(120).join("\n");
		expect(cancelCount).toBe(0);
		expect(afterBack).toContain("Memory Backend");
		expect(afterBack).toContain("Esc to close");
		expect(afterBack).not.toContain("Esc to go back");

		comp.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("masks configured OpenViking API keys and never prefills the secret editor", () => {
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_API_KEY: undefined,
			OPENVIKING_BEARER_TOKEN: undefined,
			OPENVIKING_CONFIG_FILE: "/tmp/omp-settings-selector-missing-ov.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-settings-selector-missing-ovcli.conf",
		});
		try {
			const secret = "openviking-super-secret-value";
			settings.set("memory.backend", "openviking");
			settings.set("openviking.apiKey", secret);
			const comp = createSelector();
			for (const ch of "openviking api key") comp.handleInput(ch);

			const list = renderPlain(comp);
			expect(list).toContain("OpenViking API Key");
			expect(list).toContain("(configured)");
			expect(list).not.toContain(secret);

			comp.handleInput("\n");
			const editor = renderPlain(comp);
			expect(editor).toContain("Empty + Enter to unset local value");
			expect(editor).not.toContain(secret);

			comp.handleInput("\x1b");
			expect(settings.get("openviking.apiKey")).toBe(secret);

			comp.handleInput("\n");
			comp.handleInput("\n");
			expect(settings.get("openviking.apiKey")).toBe("");
		} finally {
			restoreEnvironment();
		}
	});

	it("edits file-derived OpenViking values from their effective value", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-openviking-"));
		const configPath = path.join(dir, "ov.conf");
		await Bun.write(configPath, JSON.stringify({ claude_code: { autoRecall: false } }));
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_AUTO_RECALL: undefined,
			OPENVIKING_CONFIG_FILE: configPath,
			OPENVIKING_CLI_CONFIG_FILE: path.join(dir, "missing-ovcli.conf"),
		});
		try {
			settings.set("memory.backend", "openviking");
			const comp = createSelector();
			for (const ch of "openviking auto recall") comp.handleInput(ch);
			await waitForRender(
				comp,
				rendered => rendered.includes("OpenViking Auto Recall") && rendered.includes("false"),
			);

			// The schema default is true, but the active file profile says false.
			// Cycling must start from false so the first action writes true.
			expect(settings.get("openviking.autoRecall")).toBe(true);
			selectSearchResultByDescription(comp, "Search OpenViking before each agent turn");
			comp.handleInput("\n");
			expect(settings.get("openviking.autoRecall")).toBe(true);
			await waitForRender(comp, rendered => /OpenViking Auto Recall\s+true/.test(rendered));
			const effective = await loadOpenVikingConfig(settings, {
				OPENVIKING_CONFIG_FILE: configPath,
				OPENVIKING_CLI_CONFIG_FILE: path.join(dir, "missing-ovcli.conf"),
			});
			expect(effective.autoRecall).toBe(true);
		} finally {
			restoreEnvironment();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("shows and disables OpenViking values controlled by environment variables", async () => {
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_AUTO_RECALL: "false",
			OPENVIKING_CONFIG_FILE: "/tmp/omp-settings-selector-missing-ov.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-settings-selector-missing-ovcli.conf",
		});
		try {
			settings.set("memory.backend", "openviking");
			const comp = createSelector();
			for (const ch of "openviking auto recall") comp.handleInput(ch);
			await waitForRender(comp, output => output.includes("false (OPENVIKING_AUTO_RECALL)"));
			selectSearchResultByDescription(comp, "Controlled by OPENVIKING_AUTO_RECALL");
			const rendered = renderPlain(comp);

			expect(rendered).toContain("Controlled by OPENVIKING_AUTO_RECALL");
			expect(settings.get("openviking.autoRecall")).toBe(true);
			comp.handleInput("\n");
			expect(settings.get("openviking.autoRecall")).toBe(true);
		} finally {
			restoreEnvironment();
		}
	});

	it("shows the effective workspace-peer opt-out from the environment", async () => {
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_WORKSPACE_PEER: "0",
			OPENVIKING_CONFIG_FILE: "/tmp/omp-settings-selector-workspace-peer-missing-ov.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-settings-selector-workspace-peer-missing-ovcli.conf",
		});
		try {
			settings.set("memory.backend", "openviking");
			const comp = createSelector();
			for (const ch of "openviking workspace peer") comp.handleInput(ch);
			await waitForRender(comp, output => output.includes("false (OPENVIKING_WORKSPACE_PEER)"));
			selectSearchResultByDescription(comp, "Controlled by OPENVIKING_WORKSPACE_PEER");
			const rendered = renderPlain(comp);

			expect(rendered).toContain("Controlled by OPENVIKING_WORKSPACE_PEER");
			expect(settings.get("openviking.workspacePeer")).toBe(true);
			comp.handleInput("\n");
			expect(settings.get("openviking.workspacePeer")).toBe(true);
		} finally {
			restoreEnvironment();
		}
	});

	it("shows the effective recall peer scope from the environment", async () => {
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_RECALL_PEER_SCOPE: "all",
			OPENVIKING_CONFIG_FILE: "/tmp/omp-settings-selector-recall-scope-missing-ov.conf",
			OPENVIKING_CLI_CONFIG_FILE: "/tmp/omp-settings-selector-recall-scope-missing-ovcli.conf",
		});
		try {
			settings.set("memory.backend", "openviking");
			const comp = createSelector();
			for (const ch of "openviking recall peer scope") comp.handleInput(ch);
			await waitForRender(comp, output => output.includes("all (OPENVIKING_RECALL_PEER_SCOPE)"));
			const rendered = renderPlain(comp);

			expect(rendered).toContain("all (OPENVIKING_RECALL_PEER_SCOPE)");
			expect(settings.get("openviking.recallPeerScope")).toBe("actor");
		} finally {
			restoreEnvironment();
		}
	});

	it("keeps OpenViking settings editable when a boolean environment value is invalid", async () => {
		const configPath = "/tmp/omp-settings-selector-invalid-env-missing-ov.conf";
		const cliConfigPath = "/tmp/omp-settings-selector-invalid-env-missing-ovcli.conf";
		const restoreEnvironment = replaceEnvironment({
			OPENVIKING_AUTO_RECALL: "invalid",
			OPENVIKING_CONFIG_FILE: configPath,
			OPENVIKING_CLI_CONFIG_FILE: cliConfigPath,
		});
		try {
			settings.set("memory.backend", "openviking");
			settings.set("openviking.autoRecall", false);
			const comp = createSelector();
			for (const ch of "openviking auto recall") comp.handleInput(ch);
			const before = await waitForRender(comp, output => /OpenViking Auto Recall\s+false/.test(output));

			expect(before).not.toContain("Controlled by OPENVIKING_AUTO_RECALL");
			selectSearchResultByDescription(comp, "Search OpenViking before each agent turn");
			comp.handleInput("\n");
			expect(settings.get("openviking.autoRecall")).toBe(true);
			await waitForRender(comp, output => /OpenViking Auto Recall\s+true/.test(output));

			const effective = await loadOpenVikingConfig(settings, {
				OPENVIKING_AUTO_RECALL: "invalid",
				OPENVIKING_CONFIG_FILE: configPath,
				OPENVIKING_CLI_CONFIG_FILE: cliConfigPath,
			});
			expect(effective.autoRecall).toBe(true);
		} finally {
			restoreEnvironment();
		}
	});
});
