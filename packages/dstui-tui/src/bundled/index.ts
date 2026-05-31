/**
 * Bundled `pi-dstui` components.
 *
 * Each entry is a raw DSL source string baked into the package plus a
 * pre-compiled {@link ModuleDef}. The `mount()` helpers reuse the cached
 * module so a hot path (picker prompt loop, confirm spam) does not
 * re-parse and re-compile the same bytes on every call. These are the
 * on-disk equivalent of the three example components in upstream
 * `unitdhda/pi-dstui`; the implementations are written from scratch
 * against this runtime's safety invariants.
 */

import { compileModule, type ModuleDef, type SettleEvent } from "@oh-my-pi/pi-dstui";
import { mountDstuiOverlay, type OverlayMount } from "../overlay";
import confirmSource from "./confirm.dsl" with { type: "text" };
import pickerSource from "./picker.dsl" with { type: "text" };
import progressSource from "./progress.dsl" with { type: "text" };

export const BUNDLED_DSTUI_SOURCES = Object.freeze({
	picker: pickerSource,
	confirm: confirmSource,
	progress: progressSource,
});

export type BundledComponentName = keyof typeof BUNDLED_DSTUI_SOURCES;

const BUNDLED_DSTUI_MODULES: Readonly<Record<BundledComponentName, ModuleDef>> = Object.freeze({
	picker: compileModule(pickerSource),
	confirm: compileModule(confirmSource),
	progress: compileModule(progressSource),
});

/** Look up a bundled DSL module source by name. */
export function getBundledSource(name: BundledComponentName): string {
	return BUNDLED_DSTUI_SOURCES[name];
}

/** Look up a compiled bundled {@link ModuleDef} by name. */
export function getBundledModule(name: BundledComponentName): ModuleDef {
	return BUNDLED_DSTUI_MODULES[name];
}

/** Config accepted by the bundled picker. */
export interface PickerConfig {
	title?: string;
	items: readonly string[];
	selectedIndex?: number;
}

/** Mount the bundled picker. Resolves with `{ reason: "emit", value: number }` on Enter or `{ reason: "cancel", value: null }` on Escape. */
export async function mountPicker(mount: OverlayMount, config: PickerConfig): Promise<SettleEvent> {
	return mountDstuiOverlay(mount, {
		module: BUNDLED_DSTUI_MODULES.picker,
		config: {
			title: config.title,
			items: [...config.items],
			"selected-index": config.selectedIndex ?? 0,
		},
	});
}

/** Config accepted by the bundled confirm. */
export interface ConfirmConfig {
	prompt: string;
	yesLabel?: string;
	noLabel?: string;
	defaultYes?: boolean;
}

/** Mount the bundled confirm. Resolves with `{ reason: "emit", value: boolean }` on Enter or `{ reason: "cancel", value: null }` on Escape. */
export async function mountConfirm(mount: OverlayMount, config: ConfirmConfig): Promise<SettleEvent> {
	return mountDstuiOverlay(mount, {
		module: BUNDLED_DSTUI_MODULES.confirm,
		config: {
			prompt: config.prompt,
			"yes-label": config.yesLabel,
			"no-label": config.noLabel,
			"default-yes": config.defaultYes ?? true,
		},
	});
}

/** Config accepted by the bundled progress component. */
export interface ProgressConfig {
	caption?: string;
	tickMs?: number;
}

/** Mount the bundled progress component. Resolves with `{ reason: "cancel", value: null }` on Escape. */
export async function mountProgress(mount: OverlayMount, config: ProgressConfig = {}): Promise<SettleEvent> {
	return mountDstuiOverlay(mount, {
		module: BUNDLED_DSTUI_MODULES.progress,
		config: {
			caption: config.caption,
			"tick-ms": config.tickMs,
		},
	});
}
