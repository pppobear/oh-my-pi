import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "openviking") return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const backend = this.session.settings.get("memory.backend");
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}

			for (const item of params.items) {
				state.rememberScoped(item.content, {
					source: "coding-agent-retain",
					importance: 0.75,
					metadata: {
						session_id: state.sessionId,
						cwd: state.session.sessionManager.getCwd(),
						context: item.context ?? null,
						tool: "retain",
					},
					scope: "bank",
					extract: true,
					extractEntities: true,
					veracity: "tool",
					memoryType: "fact",
				});
			}

			const count = params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			return {
				content: [{ type: "text", text: `${count} ${noun} stored.` }],
				details: { count },
			};
		}

		if (backend === "openviking") {
			const state = this.session.getOpenVikingSessionState?.();
			const primary = state?.aliasOf ?? state;
			if (!primary) {
				throw new Error("OpenViking backend is not initialised for this session.");
			}
			const outcome = await primary.saveMany(params.items);
			if (outcome.status === "failed") {
				throw new Error(outcome.error);
			}
			if (outcome.status === "reconciling") {
				return { content: [{ type: "text", text: outcome.message }], details: { count: 0 } };
			}
			if (outcome.status === "completed") {
				return {
					content: [
						{
							type: "text",
							text:
								outcome.extracted === 0
									? "0 memories stored; OpenViking completed extraction without creating a durable memory."
									: "OpenViking completed extraction, but did not report a durable-memory count.",
						},
					],
					details: { count: 0 },
				};
			}
			const count = outcome.status === "stored" ? outcome.extracted : params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			const inputNoun = count === 1 ? "memory input" : "memory inputs";
			const text =
				outcome.status === "stored"
					? `${count} ${noun} stored.`
					: outcome.reason === "timeout"
						? `${count} ${noun} queued for extraction.`
						: outcome.reason === "aborted"
							? `${count} ${inputNoun} archived; extraction status check interrupted.`
							: `${count} ${inputNoun} archived; extraction status unavailable.`;
			return {
				content: [{ type: "text", text }],
				details: outcome.status === "queued" && outcome.reason === "timeout" ? { count, queued: true } : { count },
			};
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Push every item onto the session-owned queue and return immediately.
		// The queue flushes either when it reaches its batch threshold or when
		// its debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
