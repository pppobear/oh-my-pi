import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type {
	MemoryBackend,
	MemoryBackendSaveInput,
	MemoryBackendSearchItem,
	MemoryBackendStartOptions,
} from "../memory-backend/types";
import openVikingDeveloperInstructions from "../prompts/system/openviking-developer-instructions.md" with {
	type: "text",
};
import { OpenVikingApi, type OpenVikingSearchItem } from "./client";
import { loadOpenVikingConfig } from "./config";
import { getOpenVikingSessionState, OpenVikingSessionState, setOpenVikingSessionState } from "./state";
import { memoryUriFromOpenVikingUri } from "./uri";

export const OPENVIKING_DEVELOPER_INSTRUCTIONS = openVikingDeveloperInstructions.trim();

export const openVikingBackend: MemoryBackend = {
	id: "openviking",

	async start(options: MemoryBackendStartOptions): Promise<void> {
		const { session, settings } = options;
		const transcriptId = session.sessionManager.getSessionId();
		if (!transcriptId || session.isDisposed) return;

		if (options.taskDepth > 0) {
			const parent = options.parentOpenVikingSessionState?.aliasOf ?? options.parentOpenVikingSessionState;
			if (!parent || session.isDisposed) return;
			const state = new OpenVikingSessionState({
				sessionId: transcriptId,
				config: parent.config,
				client: parent.client,
				session,
				aliasOf: parent,
			});
			const previous = setOpenVikingSessionState(session, state);
			await previous?.dispose({ flush: false });
			if (session.isDisposed && getOpenVikingSessionState(session) === state) {
				setOpenVikingSessionState(session, undefined);
				await state.dispose({ flush: false });
			}
			return;
		}

		try {
			const config = await loadOpenVikingConfig(settings);
			if (session.isDisposed) return;
			const client = new OpenVikingApi(config);
			const startingBranchIds = session.sessionManager.getBranch().map(entry => entry.id);
			const transcriptStillCurrent = (): boolean => {
				if (session.sessionManager.getSessionId() !== transcriptId) return false;
				const currentBranch = session.sessionManager.getBranch();
				return startingBranchIds.every((id, index) => currentBranch[index]?.id === id);
			};
			const candidate = new OpenVikingSessionState({ sessionId: transcriptId, config, client, session });
			const ensured = await client.ensureSession(candidate.sessionId);
			if (!ensured.ok) throw new Error(ensured.error ?? `HTTP ${ensured.status ?? "unknown"}`);
			if (session.isDisposed) {
				await candidate.dispose({ flush: false });
				return;
			}
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
			const state = previous
				? new OpenVikingSessionState({ sessionId: transcriptId, config, client, session })
				: candidate;
			setOpenVikingSessionState(session, state);
			state.attachSessionListeners();
		} catch (error) {
			logger.warn("OpenViking: backend start failed", { error: String(error) });
		}
	},

	async stop({ session }): Promise<void> {
		const state = getOpenVikingSessionState(session);
		if (!state) return;
		let sourceFlushed = false;
		try {
			sourceFlushed = await state.flushAndCommit();
			if (!sourceFlushed) {
				logger.warn("OpenViking: runtime switch left a resumable transcript tail", {
					sessionId: state.sessionId,
				});
			}
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
		let transitionError: Error | undefined;
		try {
			const nextConfig = await loadOpenVikingConfig(session.settings);
			if (!state.baselineWorkspaceTransition(nextConfig, sourceFlushed)) {
				transitionError = new Error(
					"OpenViking could not safely baseline the destination scope because the source transcript tail was not flushed.",
				);
			} else {
				await session.sessionManager.flush();
			}
		} catch (error) {
			transitionError = error instanceof Error ? error : new Error(String(error));
		}
		if (getOpenVikingSessionState(session) !== state) return;
		setOpenVikingSessionState(session, undefined);
		await state.dispose({ flush: false });
		if (transitionError) throw transitionError;
	},

	async buildDeveloperInstructions(_agentDir, settings, session): Promise<string | undefined> {
		if (settings.get("memory.backend") !== "openviking") return undefined;
		const state = getOpenVikingSessionState(session);
		if (!state?.isReady) return undefined;
		const primary = state?.aliasOf ?? state;
		const parts = [OPENVIKING_DEVELOPER_INSTRUCTIONS];
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
		if (!state?.isReady || !primary?.isReady) {
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
		if (!state?.isReady || !primary) {
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
		let results: OpenVikingSearchItem[];
		try {
			results = await primary.search(query, limit, options?.signal);
		} catch (error) {
			if (options?.signal?.aborted) {
				return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
			}
			if (!primary.isReady) {
				return {
					backend: "openviking" as const,
					query,
					count: 0,
					items: [],
					message: "OpenViking workspace changed while search was running.",
				};
			}
			throw error;
		}
		if (options?.signal?.aborted) {
			return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
		}
		if (!primary.isReady) {
			return {
				backend: "openviking" as const,
				query,
				count: 0,
				items: [],
				message: "OpenViking workspace changed while search was running.",
			};
		}
		let items: MemoryBackendSearchItem[];
		try {
			items = await Promise.all(
				results.map(async item => {
					const uri = memoryUriFromOpenVikingUri(item.uri);
					return {
						id: uri,
						content: (await primary.resolveItemContent(item, options?.signal)).trim(),
						score: item.score,
						source: item._sourceType,
						metadata: {
							uri,
							category: item.category,
							level: item.level,
							origin: item.origin,
							rank: item.rank,
							mode: item.mode,
						},
					};
				}),
			);
		} catch (error) {
			if (options?.signal?.aborted) {
				return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
			}
			if (!primary.isReady) {
				return {
					backend: "openviking" as const,
					query,
					count: 0,
					items: [],
					message: "OpenViking workspace changed while search was running.",
				};
			}
			throw error;
		}
		if (options?.signal?.aborted) {
			return { backend: "openviking" as const, query, count: 0, items: [], message: "Search aborted." };
		}
		if (!primary.isReady) {
			return {
				backend: "openviking" as const,
				query,
				count: 0,
				items: [],
				message: "OpenViking workspace changed while search was running.",
			};
		}
		return { backend: "openviking" as const, query, count: items.length, items };
	},

	async save({ session }, input: MemoryBackendSaveInput) {
		const state = getOpenVikingSessionState(session);
		const primary = state?.aliasOf ?? state;
		if (!state?.isReady || !primary) {
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
		if (!state?.isReady) return undefined;
		const primary = state?.aliasOf ?? state;
		return await primary?.recallForCompaction(messages);
	},
};
