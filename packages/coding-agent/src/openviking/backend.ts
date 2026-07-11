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
			await previous?.dispose({ flush: false });
			return;
		}

		try {
			const config = await loadOpenVikingConfig(settings);
			const client = new OpenVikingApi(config);
			const startingBranchIds = session.sessionManager.getBranch().map(entry => entry.id);
			const transcriptStillCurrent = (): boolean => {
				if (session.sessionId !== sessionId) return false;
				const currentBranch = session.sessionManager.getBranch();
				return startingBranchIds.every((id, index) => currentBranch[index]?.id === id);
			};
			const candidate = new OpenVikingSessionState({ sessionId, config, client, session });
			const ensured = await client.ensureSession(candidate.sessionId);
			if (!ensured.ok) throw new Error(ensured.error ?? `HTTP ${ensured.status ?? "unknown"}`);
			// A session transition may have won while the remote ensure was in
			// flight. Never install state whose remote id belongs to the old
			// transcript; the transition/reconcile caller will retry for the live id.
			if (!transcriptStillCurrent()) {
				await candidate.dispose({ flush: false });
				return;
			}
			const previous = getOpenVikingSessionState(session);
			if (previous) {
				if (!(await previous.flushAndCommit()))
					throw new Error("existing OpenViking session tail could not be flushed");
				await session.sessionManager.flush();
				await previous.dispose({ flush: false });
			}
			if (!transcriptStillCurrent()) {
				if (previous && getOpenVikingSessionState(session) === previous) {
					setOpenVikingSessionState(session, undefined);
				}
				await candidate.dispose({ flush: false });
				return;
			}
			// Re-read the cursor after the previous state has durably advanced it.
			const state = previous ? new OpenVikingSessionState({ sessionId, config, client, session }) : candidate;
			setOpenVikingSessionState(session, state);
			state.attachSessionListeners();
		} catch (error) {
			logger.warn("OpenViking: backend start failed", { error: String(error) });
		}
	},

	async stop({ session }): Promise<void> {
		const state = getOpenVikingSessionState(session);
		if (!state) return;
		try {
			if (!(await state.flushAndCommit())) {
				logger.warn("OpenViking: runtime switch left a resumable transcript tail", {
					sessionId: state.sessionId,
				});
			}
			await session.sessionManager.flush();
		} catch (error) {
			// Runtime settings changes do not replace the SessionManager transcript.
			// Detaching is safe: the persisted capture cursor (or an at-least-once
			// replay when it could not be flushed) retries this tail if the profile is
			// activated again. This also lets a corrected API key replace a broken one.
			logger.warn("OpenViking: runtime switch could not flush the current tail", {
				sessionId: state.sessionId,
				error: String(error),
			});
		}
		if (getOpenVikingSessionState(session) !== state) return;
		setOpenVikingSessionState(session, undefined);
		await state.dispose({ flush: false });
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		if (settings.get("memory.backend") !== "openviking") return undefined;
		const state = getOpenVikingSessionState(session);
		if (!state?.isReady) return undefined;
		const primary = state?.aliasOf ?? state;
		const parts = [STATIC_INSTRUCTIONS];
		if (primary?.lastRecallSnippet) parts.push(primary.lastRecallSnippet);
		return parts.join("\n\n");
	},

	async beforeAgentStartPrompt(session, promptText): Promise<string | undefined> {
		const state = getOpenVikingSessionState(session);
		return await state?.beforeAgentStartPrompt(promptText);
	},

	async clear(): Promise<void> {
		throw new Error(
			"OpenViking memory is server-side; /memory clear is not supported. Delete specific memory resources in OpenViking instead.",
		);
	},

	async enqueue(_agentDir, _cwd, session): Promise<void> {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ? undefined : state;
		if (primary && !(await primary.forceRetainCurrentSession())) {
			throw new Error("OpenViking could not capture and archive the current session tail.");
		}
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
		const outcome = await primary.save(input.content, input.context);
		if (outcome.status === "stored") {
			return { backend: "openviking" as const, stored: outcome.extracted };
		}
		if (outcome.status === "completed") {
			return {
				backend: "openviking" as const,
				stored: 0,
				message:
					outcome.extracted === 0
						? "OpenViking completed extraction without creating a durable memory."
						: "OpenViking completed extraction, but did not report a durable-memory count.",
			};
		}
		if (outcome.status === "reconciling") {
			return { backend: "openviking" as const, stored: 0, message: outcome.message };
		}
		if (outcome.status === "queued") {
			return {
				backend: "openviking" as const,
				stored: 0,
				...(outcome.reason === "timeout" ? { queued: true } : {}),
				message: outcome.message,
			};
		}
		return { backend: "openviking" as const, stored: 0, message: outcome.error };
	},

	async preCompactionContext(messages: AgentMessage[], settings: Settings, session): Promise<string | undefined> {
		if (settings.get("memory.backend") !== "openviking") return undefined;
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		return await primary?.recallForCompaction(messages);
	},
};
