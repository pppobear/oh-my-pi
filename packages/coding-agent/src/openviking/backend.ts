import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { MemoryBackend, MemoryBackendSaveInput, MemoryBackendStartOptions } from "../memory-backend/types";
import { OpenVikingApi } from "./client";
import { loadOpenVikingConfig } from "./config";
import { getOpenVikingSessionState, OpenVikingSessionState, setOpenVikingSessionState } from "./state";
import { memoryUriFromOpenVikingUri } from "./uri";

const STATIC_INSTRUCTIONS = [
	"OpenViking memory is active.",
	"Use recall to search durable OpenViking memories before relying on guesses about user preferences or prior work.",
	"Use retain to store durable facts, decisions, preferences, and reusable project knowledge.",
	"Do not retain OpenViking recall blocks or transient tool output unless the user explicitly asked to remember it.",
].join("\n");

export const openVikingBackend: MemoryBackend = {
	id: "openviking",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings } = options;
		const sessionId = session.sessionId;
		if (!sessionId) return;

		if (options.taskDepth > 0) {
			const parent = options.parentOpenVikingSessionState?.aliasOf ?? options.parentOpenVikingSessionState;
			if (!parent) return;
			const previous = setOpenVikingSessionState(
				session,
				new OpenVikingSessionState({
					sessionId,
					config: parent.config,
					client: parent.client,
					session,
					aliasOf: parent,
				}),
			);
			previous?.dispose();
			return;
		}

		try {
			const config = await loadOpenVikingConfig(settings);
			const client = new OpenVikingApi(config);
			const state = new OpenVikingSessionState({ sessionId, config, client, session });
			const ensured = await client.ensureSession(state.sessionId);
			if (!ensured.ok) throw new Error(ensured.error ?? `HTTP ${ensured.status ?? "unknown"}`);
			const previous = setOpenVikingSessionState(session, state);
			previous?.dispose();
			state.attachSessionListeners();
		} catch (error) {
			logger.warn("OpenViking: backend start failed", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		if (settings.get("memory.backend") !== "openviking") return undefined;
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		const parts = [STATIC_INSTRUCTIONS];
		if (primary?.lastRecallSnippet) parts.push(primary.lastRecallSnippet);
		return parts.join("\n\n");
	},

	async beforeAgentStartPrompt(session, promptText): Promise<string | undefined> {
		const state = getOpenVikingSessionState(session);
		return await state?.beforeAgentStartPrompt(promptText);
	},

	async clear(_agentDir, _cwd, session): Promise<void> {
		const previous = session ? setOpenVikingSessionState(session, undefined) : undefined;
		previous?.dispose();
		logger.warn(
			"OpenViking memory is server-side; only the local OpenViking session cache was cleared. " +
				"Delete the corresponding user memory resources from OpenViking to wipe upstream state.",
		);
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ? undefined : state;
		await primary?.forceRetainCurrentSession();
	},

	async status({ session }): Promise<{
		backend: "openviking";
		active: boolean;
		writable: boolean;
		searchable: boolean;
		message?: string;
		error?: string;
		database?: string;
		lastRecall?: boolean;
	}> {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "openviking",
				active: false,
				writable: false,
				searchable: false,
				message: "OpenViking backend is not initialised for this session.",
			};
		}
		const [health, ready, sessionStatus] = await Promise.all([
			primary.client.health(),
			primary.client.ready(),
			primary.client.getSession(primary.sessionId, false),
		]);
		const usable = ready.ok && sessionStatus.ok;
		return {
			backend: "openviking",
			active: health.ok,
			writable: usable,
			searchable: usable,
			database: primary.client.baseUrl,
			lastRecall: !!primary.lastRecallSnippet,
			error: usable
				? undefined
				: (sessionStatus.error ??
					ready.error ??
					health.error ??
					`HTTP ${sessionStatus.status ?? ready.status ?? health.status ?? "unknown"}`),
		};
	},

	async search({ session }, query, options) {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "openviking" as const,
				query,
				count: 0,
				items: [],
				message: "OpenViking backend is not initialised for this session.",
			};
		}
		if (options?.signal?.aborted) {
			return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
		}
		const limit = Math.max(1, Math.floor(options?.limit ?? primary.config.recallLimit));
		const results = await primary.search(query, limit);
		if (options?.signal?.aborted) {
			return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
		}
		const items = results.map(item => {
			const uri = memoryUriFromOpenVikingUri(item.uri);
			return {
				id: uri,
				content: (item.abstract || item.overview || uri).trim(),
				score: item.score,
				source: item._sourceType,
				metadata: { uri, category: item.category, level: item.level },
			};
		});
		return { backend: "openviking" as const, query, count: items.length, items };
	},

	async save({ session }, input: MemoryBackendSaveInput) {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!primary) {
			return {
				backend: "openviking" as const,
				stored: 0,
				message: "OpenViking backend is not initialised for this session.",
			};
		}
		const ok = await primary.save(input.content, input.context);
		return {
			backend: "openviking" as const,
			stored: ok ? 1 : 0,
			message: ok ? undefined : "OpenViking did not acknowledge the memory write.",
		};
	},

	async preCompactionContext(messages: AgentMessage[], settings: Settings, session): Promise<string | undefined> {
		if (settings.get("memory.backend") !== "openviking") return undefined;
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		return await primary?.recallForCompaction(messages);
	},
};
