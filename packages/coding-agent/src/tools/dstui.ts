/**
 * `dstui` tool — mount a safe `pi-dstui` component as a TUI overlay.
 *
 * The tool is gated behind two preconditions, checked at registration
 * time via {@link DstuiTool.createIf}:
 *
 *   1. `dstui.enabled` setting is `true` (default `true`; users opt out via `omp config set dstui.enabled false`).
 *   2. The current session has an interactive UI (`session.hasUI`).
 *
 * The DSL itself enforces parser/evaluator caps, output cell limits,
 * prototype-key denial, and idempotent settle — see `@oh-my-pi/pi-dstui`.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ModuleDef, SettleEvent } from "@oh-my-pi/pi-dstui";
import { DstuiStore, StoreNameError } from "@oh-my-pi/pi-dstui-store";
import { mountDstuiOverlay, type OverlayMount } from "@oh-my-pi/pi-dstui-tui";
import { getConfigRootDir, prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import dstuiDescription from "../prompts/tools/dstui.md" with { type: "text" };
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

const dstuiSchema = z.object({
	source: z.string().describe("inline DSL source").optional(),
	store: z
		.string()
		.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)
		.describe("named persisted module")
		.optional(),
	componentName: z.string().describe("defcomponent to instantiate (default: first)").optional(),
	config: z.record(z.string(), z.unknown()).describe("component config / params").optional(),
	save: z.boolean().describe("persist `source` under `store` before mounting").optional(),
	saveState: z.boolean().describe("persist the instance settle value under `store`").optional(),
});

export type DstuiToolInput = z.infer<typeof dstuiSchema>;

export interface DstuiToolDetails {
	source?: "inline" | "store";
	store?: string;
	component?: string;
	settle?: SettleEvent;
}

/**
 * Mount a compiled DSL module inside the active `ExtensionUIContext` as
 * a focusable overlay and return the settle event.
 */
export class DstuiTool implements AgentTool<typeof dstuiSchema, DstuiToolDetails> {
	readonly name = "dstui";
	readonly approval = "read" as const;
	readonly label = "DSTUI";
	readonly summary = "Mount a safe pi-dstui DSL component as a TUI overlay";
	readonly description: string = prompt.render(dstuiDescription);
	readonly parameters = dstuiSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;

	static #sharedStore: DstuiStore | undefined;

	static #store(): DstuiStore {
		if (!DstuiTool.#sharedStore) {
			DstuiTool.#sharedStore = new DstuiStore({ root: path.join(getConfigRootDir(), "dstui") });
		}
		return DstuiTool.#sharedStore;
	}


	static createIf(session: ToolSession): DstuiTool | null {
		if (!session.hasUI) return null;
		if (!session.settings.get("dstui.enabled")) return null;
		return new DstuiTool();
	}

	async execute(
		_toolCallId: string,
		params: DstuiToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DstuiToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<DstuiToolDetails>> {
		if (!context?.hasUI || !context.ui) {
			context?.abort();
			throw new ToolAbortError("dstui tool requires an interactive UI");
		}
		if (!params.source && !params.store) {
			return {
				content: [{ type: "text" as const, text: "Error: dstui requires `source` or `store`" }],
				details: {},
			};
		}

		let module: ModuleDef | undefined;
		let detailSource: DstuiToolDetails["source"];
		try {
			if (params.source && params.store && params.save) {
				await DstuiTool.#store().saveModule(params.store, params.source);
			}
			if (params.source && !params.save) {
				detailSource = "inline";
			} else if (params.store) {
				const entry = await DstuiTool.#store().loadModule(params.store);
				if (!entry) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: no dstui module saved under "${params.store}"`,
							},
						],
						details: { store: params.store },
					};
				}
				module = entry.module;
				detailSource = "store";
			} else {
				detailSource = "inline";
			}
		} catch (err) {
			if (err instanceof StoreNameError) {
				return {
					content: [{ type: "text" as const, text: `Error: ${err.message}` }],
					details: { store: params.store },
				};
			}
			throw err;
		}

		const mount = context.ui as unknown as OverlayMount;
		let settle: SettleEvent;
		try {
			settle = await mountDstuiOverlay(mount, {
				source: module ? undefined : params.source,
				module,
				componentName: params.componentName,
				config: params.config,
				signal,
			});
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				context.abort();
				throw new ToolAbortError("dstui overlay was cancelled");
			}
			throw err;
		}

		if (params.store && params.saveState && settle.reason === "emit") {
			try {
				await DstuiTool.#store().saveState(params.store, settle.value);
			} catch {
				// State-persist failure must not corrupt the settle return; the model can retry.
			}
		}

		const text =
			settle.reason === "emit" ? `User confirmed: ${JSON.stringify(settle.value)}` : "User cancelled the overlay";
		return {
			content: [{ type: "text" as const, text }],
			details: {
				source: detailSource,
				store: params.store,
				component: params.componentName,
				settle,
			},
		};
	}
}
