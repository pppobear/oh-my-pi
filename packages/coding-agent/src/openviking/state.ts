import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { composeRecallQuery, truncateRecallQuery } from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { SESSION_CWD_TRANSITION_CUSTOM_TYPE } from "../session/session-entries";
import type {
	OpenVikingApi,
	OpenVikingCommitStart,
	OpenVikingSearchItem,
	OpenVikingTask,
	OpenVikingTaskWaitResult,
} from "./client";
import type { OpenVikingConfig } from "./config";
import { memoryUriFromOpenVikingUri } from "./uri";

const kOpenVikingSessionState = Symbol("openviking.sessionState");
const OPENVIKING_SESSION_PREFIX = "omp-";
const OPENVIKING_CAPTURE_CURSOR_TYPE = "openviking-capture-cursor";
const OPENVIKING_CAPTURE_CURSOR_VERSION = 4;
const OPENVIKING_CONTEXT_HEADER =
	"Relevant context from OpenViking. Use recall or read MCP tools to expand memory:// URIs.";

type CapturedRole = "user" | "assistant";

interface OpenVikingCursorIdentity {
	baseUrl: string;
	credentialFingerprint: string | null;
	accountId: string | null;
	userId: string | null;
	peerId: string | null;
	sessionId: string;
}

interface OpenVikingPendingExtraction {
	taskId: string;
	archiveUri: string | null;
	acceptedAt: number;
	throughMessageCount: number;
	throughUserTurns: number;
}

interface OpenVikingCommitTaskBaseline {
	taskIds: string[];
	preparedAt: number;
	commitCount: number | null;
	sessionUri: string | null;
	throughMessageCount: number;
	throughUserTurns: number;
}

interface OpenVikingSessionCommitMarker {
	commitCount: number;
	sessionUri: string;
}

interface OpenVikingCaptureCursor {
	version: 4;
	identity: OpenVikingCursorIdentity;
	capturedMessageCount: number;
	archivedUserTurns: number;
	hasUnarchivedRemoteMessages: boolean;
	commitTaskBaseline: OpenVikingCommitTaskBaseline | null;
	pendingExtractions: OpenVikingPendingExtraction[];
}

export type OpenVikingSaveOutcome =
	| { status: "stored"; taskId: string; archiveUri: string; extracted: number }
	| { status: "completed"; taskId: string; archiveUri: string; extracted?: number }
	| {
			status: "queued";
			taskId: string;
			archiveUri?: string;
			reason: "timeout" | "unknown" | "aborted";
			message: string;
	  }
	| { status: "reconciling"; message: string }
	| { status: "failed"; error: string };

export interface OpenVikingSaveInput {
	content: string;
	context?: string;
}

interface OpenVikingArchiveAccepted {
	status: "accepted";
	pending: OpenVikingPendingExtraction;
}

type OpenVikingArchiveOutcome =
	| OpenVikingArchiveAccepted
	| { status: "skipped"; reason: string }
	| { status: "orphaned"; archiveUri: string; error: string }
	| { status: "blocked"; error: string }
	| { status: "unknown"; error: string }
	| { status: "failed"; error: string };

type OpenVikingCommitTaskRecovery =
	| OpenVikingArchiveAccepted
	| { status: "orphaned"; archiveUri: string; error: string }
	| { status: "blocked"; error: string }
	| { status: "none" }
	| { status: "unknown"; error: string };

type OpenVikingExplicitWriteStart =
	| OpenVikingArchiveOutcome
	| Extract<OpenVikingSaveOutcome, { status: "reconciling" }>;

interface AgentSessionWithOpenVikingState extends AgentSession {
	[kOpenVikingSessionState]?: OpenVikingSessionState;
}

export function getOpenVikingSessionState(session: AgentSession | undefined): OpenVikingSessionState | undefined {
	return session ? (session as AgentSessionWithOpenVikingState)[kOpenVikingSessionState] : undefined;
}

export function setOpenVikingSessionState(
	session: AgentSession,
	state: OpenVikingSessionState | undefined,
): OpenVikingSessionState | undefined {
	const typed = session as AgentSessionWithOpenVikingState;
	const previous = typed[kOpenVikingSessionState];
	if (state) typed[kOpenVikingSessionState] = state;
	else delete typed[kOpenVikingSessionState];
	return previous;
}

export interface OpenVikingSessionStateOptions {
	sessionId: string;
	config: OpenVikingConfig;
	client: OpenVikingApi;
	session: AgentSession;
	aliasOf?: OpenVikingSessionState;
	lastCapturedMessageCount?: number;
	lastCommittedTurn?: number;
}

export interface OpenVikingRekeyOptions {
	/** A newly-created remote session inherits local history that was already captured by its parent session. */
	baselineExistingTranscript?: boolean;
}

export interface OpenVikingDisposeOptions {
	/** Flush new transcript content and pending commits before detaching. Defaults to true. */
	flush?: boolean;
}

export class OpenVikingSessionState {
	sessionId: string;
	readonly config: OpenVikingConfig;
	readonly client: OpenVikingApi;
	readonly session: AgentSession;
	readonly aliasOf?: OpenVikingSessionState;
	readonly #aliasedPrimarySessionId?: string;
	lastRecallSnippet?: string;
	lastCapturedMessageCount: number;
	lastCommittedTurn: number;
	unsubscribe?: () => void;
	#operationTail: Promise<void> = Promise.resolve();
	#pendingCommit = false;
	#commitTaskBaseline: OpenVikingCommitTaskBaseline | null = null;
	#pendingExtractions: OpenVikingPendingExtraction[] = [];
	#commitRecoveryMonitorKeys = new Set<string>();
	#monitoredTaskIds = new Set<string>();
	#monitorAbortController = new AbortController();
	#monitoringEnabled = false;
	#sessionEpoch = 0;
	#readyEpochs = new Set<number>([0]);
	#acceptWrites = true;
	readonly #workspaceCwd: string;

	constructor(options: OpenVikingSessionStateOptions) {
		this.sessionId = deriveOpenVikingSessionId(options.sessionId);
		this.config = options.config;
		this.client = options.client;
		this.session = options.session;
		this.aliasOf = options.aliasOf;
		this.#aliasedPrimarySessionId = options.aliasOf?.sessionId;
		this.#workspaceCwd = options.session.settings.getCwd();
		const persisted = this.#loadCaptureCursor(this.sessionId);
		// A session without a cursor deliberately starts from zero: replaying is
		// at-least-once and cannot lose a tail that crashed before it was recorded.
		this.lastCapturedMessageCount = options.lastCapturedMessageCount ?? persisted?.capturedMessageCount ?? 0;
		this.lastCommittedTurn = options.lastCommittedTurn ?? persisted?.archivedUserTurns ?? 0;
		this.#pendingCommit = persisted?.hasUnarchivedRemoteMessages ?? false;
		this.#commitTaskBaseline = persisted?.commitTaskBaseline ?? null;
		this.#pendingExtractions = persisted?.pendingExtractions ?? [];
	}

	get isReady(): boolean {
		return (
			this.#acceptWrites &&
			(this.aliasOf
				? this.aliasOf.isReady && this.aliasOf.sessionId === this.#aliasedPrimarySessionId
				: this.#readyEpochs.has(this.#sessionEpoch))
		);
	}

	async rekeySession(sessionId: string, options: OpenVikingRekeyOptions = {}): Promise<boolean> {
		const nextSessionId = deriveOpenVikingSessionId(sessionId);
		const epoch = ++this.#sessionEpoch;
		this.#resetExtractionMonitors();
		// Publish the new identity synchronously. Operations scheduled immediately
		// after rekey bind to this epoch and wait behind ensureSession in the queue.
		this.sessionId = nextSessionId;
		this.lastRecallSnippet = undefined;
		return await this.#serialize(async () => {
			if (!this.#acceptWrites) return false;
			const ensured = await this.client.ensureSession(nextSessionId);
			if (!ensured.ok) {
				logger.warn("OpenViking: session rekey failed", {
					sessionId: nextSessionId,
					error: ensured.error ?? `HTTP ${ensured.status ?? "unknown"}`,
				});
				return false;
			}
			if (!this.#acceptWrites || this.sessionId !== nextSessionId || this.#sessionEpoch !== epoch) return false;
			const persisted = this.#loadCaptureCursor(nextSessionId);
			if (persisted) {
				this.lastCapturedMessageCount = persisted.capturedMessageCount;
				this.lastCommittedTurn = persisted.archivedUserTurns;
				this.#pendingCommit = persisted.hasUnarchivedRemoteMessages;
				this.#commitTaskBaseline = persisted.commitTaskBaseline;
				this.#pendingExtractions = persisted.pendingExtractions;
			} else if (options.baselineExistingTranscript) {
				const messages = this.#activeMessages();
				this.lastCapturedMessageCount = messages.length;
				this.lastCommittedTurn = messages.filter(message => message.role === "user").length;
				this.#pendingCommit = false;
				this.#commitTaskBaseline = null;
				this.#pendingExtractions = [];
				if (!this.#persistCaptureCursor(nextSessionId)) return false;
			} else {
				this.lastCapturedMessageCount = 0;
				this.lastCommittedTurn = 0;
				this.#pendingCommit = false;
				this.#commitTaskBaseline = null;
				this.#pendingExtractions = [];
			}
			this.#readyEpochs.add(epoch);
			this.#startPendingExtractionMonitors(nextSessionId, epoch);
			return true;
		});
	}

	resetConversationTracking(): void {
		// Capture tracking is restored or baselined by rekeySession. This hook only
		// clears prompt-local recall when AgentSession changes transcripts.
		this.lastRecallSnippet = undefined;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.#monitoringEnabled = !this.aliasOf;
		this.#startPendingExtractionMonitors();
		this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end" && this.session.settings.get("memory.backend") === "openviking") {
				void this.maybeRetainOnAgentEnd(event.messages).catch(error => {
					logger.warn("OpenViking: auto-retain failed", { sessionId: this.sessionId, error: String(error) });
				});
			}
		});
	}

	async dispose(options: OpenVikingDisposeOptions = {}): Promise<boolean> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.#monitoringEnabled = false;
		if (options.flush === false) {
			this.#acceptWrites = false;
			this.#monitorAbortController.abort();
			await this.#operationTail;
			return true;
		}
		const flushed = await this.flushAndCommit();
		this.#acceptWrites = false;
		this.#monitorAbortController.abort();
		await this.#operationTail;
		return flushed;
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		this.lastRecallSnippet = undefined;
		if (!this.isReady || !this.config.autoRecall) return undefined;
		const latestPrompt = promptText.trim();
		if (latestPrompt.length < this.config.minQueryLength) return undefined;
		const history = this.#activeMessages();
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, Math.max(256, this.config.recallMaxContentChars * 4));
		const context = await this.recallForContext(truncated);
		if (!context) return undefined;
		this.lastRecallSnippet = context;
		return context;
	}

	async recallForContext(query: string): Promise<string | undefined> {
		try {
			const items = await this.client.search(query, this.config.recallLimit);
			const filtered = items.filter(item => (item.score ?? 0) >= this.config.scoreThreshold);
			return await this.formatItems(filtered);
		} catch (error) {
			logger.warn("OpenViking: recall failed", { sessionId: this.sessionId, error: String(error) });
			return undefined;
		}
	}

	async search(query: string, limit: number): Promise<OpenVikingSearchItem[]> {
		if (!this.isReady) return [];
		const items = await this.client.search(query, limit);
		return this.isReady ? items.filter(item => (item.score ?? 0) >= this.config.scoreThreshold) : [];
	}

	async save(content: string, context?: string): Promise<OpenVikingSaveOutcome> {
		return await this.saveMany([{ content, context }]);
	}

	async saveMany(items: readonly OpenVikingSaveInput[]): Promise<OpenVikingSaveOutcome> {
		const payloads = items.map(item => {
			const content = item.content.trim();
			if (!content) return null;
			return item.context?.trim() ? `${content}\n\nContext: ${item.context.trim()}` : content;
		});
		if (payloads.length === 0 || payloads.some(payload => payload === null)) {
			return { status: "failed", error: "OpenViking memory content must not be empty." };
		}
		const normalizedPayloads = payloads.filter((payload): payload is string => payload !== null);
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		const lifecycleSignal = this.#monitorAbortController.signal;
		const archive = await this.#serialize(async (): Promise<OpenVikingExplicitWriteStart> => {
			if (!this.#acceptWrites || !this.#readyEpochs.has(epoch)) {
				return { status: "failed", error: "OpenViking session is not ready for memory writes." };
			}
			if (this.#pendingCommit) {
				const recovery = await this.#archivePendingMessages(
					sessionId,
					this.lastCapturedMessageCount,
					this.lastCommittedTurn,
				);
				if (recovery.status === "accepted") {
					this.#startExtractionMonitor(recovery.pending, sessionId, epoch);
					return {
						status: "reconciling",
						message:
							"OpenViking archived the previously pending session tail; this new memory input was not sent. Retry it after reconciliation completes.",
					};
				}
				if (recovery.status === "unknown") {
					this.#startCommitRecoveryMonitor(sessionId, epoch);
					return {
						status: "reconciling",
						message: `${recovery.error}. This new memory input was not sent; automatic reconciliation remains pending.`,
					};
				}
				if (recovery.status === "failed") return recovery;
				if (recovery.status === "orphaned") {
					return {
						status: "reconciling",
						message: `${recovery.error} (${recovery.archiveUri}); this new memory input was not sent.`,
					};
				}
				if (recovery.status === "blocked") {
					return {
						status: "reconciling",
						message: `${recovery.error}. This new memory input was not sent.`,
					};
				}
				if (recovery.status === "skipped") {
					return {
						status: "reconciling",
						message:
							"OpenViking resolved the previously pending session tail without a new task; this new memory input was not sent. Retry it once more.",
					};
				}
			}
			const previouslyPendingCommit = this.#pendingCommit;
			this.#pendingCommit = true;
			if (!this.#persistCaptureCursor(sessionId)) {
				this.#pendingCommit = previouslyPendingCommit;
				return {
					status: "failed",
					error: "OpenViking memory was not sent because its retry cursor could not be saved.",
				};
			}
			const response = await this.client.addMessage(
				sessionId,
				normalizedPayloads.length === 1
					? { role: "user", content: normalizedPayloads[0] }
					: { role: "user", parts: normalizedPayloads.map(text => ({ type: "text", text: `${text}\n\n` })) },
			);
			if (!response.ok) {
				const addError = response.error ?? `HTTP ${response.status ?? "unknown"}`;
				const recovery = await this.#archivePendingMessages(
					sessionId,
					this.lastCapturedMessageCount,
					this.lastCommittedTurn,
				);
				if (recovery.status === "failed") {
					return {
						status: "reconciling",
						message: `OpenViking could not confirm the memory write (${addError}) or archive it (${recovery.error}); automatic reconciliation remains pending. Do not retry the full retain batch yet.`,
					};
				}
				if (recovery.status === "skipped") {
					return {
						status: "failed",
						error: `OpenViking did not accept the memory write (${addError}); archive reconciliation found no remote session tail.`,
					};
				}
				return recovery;
			}
			return await this.#archivePendingMessages(sessionId, this.lastCapturedMessageCount, this.lastCommittedTurn);
		});
		if (archive.status === "reconciling") return archive;
		if (archive.status === "unknown") {
			this.#startCommitRecoveryMonitor(sessionId, epoch);
			return {
				status: "reconciling",
				message: `${archive.error} Automatic reconciliation remains pending; do not retry the full retain batch yet.`,
			};
		}
		if (archive.status === "failed") return archive;
		if (archive.status === "orphaned") {
			return {
				status: "reconciling",
				message: `${archive.error} (${archive.archiveUri}); durable-memory extraction could not be verified.`,
			};
		}
		if (archive.status === "blocked") {
			return { status: "reconciling", message: archive.error };
		}
		if (archive.status === "skipped") {
			return { status: "failed", error: `OpenViking skipped memory extraction (${archive.reason}).` };
		}
		return await this.#waitForExplicitExtraction(archive.pending, sessionId, epoch, lifecycleSignal);
	}

	async forceRetainCurrentSession(): Promise<boolean> {
		if (this.aliasOf || this.session.settings.get("memory.backend") !== "openviking" || !this.#acceptWrites)
			return true;
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		return await this.#serialize(async () => {
			if (!this.#readyEpochs.has(epoch)) return false;
			const messages = this.#activeMessages();
			return await this.#captureAndMaybeCommit(sessionId, messages, true, true, epoch);
		});
	}

	async recallForCompaction(messages: AgentMessage[]): Promise<string | undefined> {
		if (!this.isReady) return undefined;
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		const flat = flattenAgentMessages(messages);
		const lastUser = flat.findLast(message => message.role === "user");
		if (!lastUser) return undefined;
		const query = composeRecallQuery(lastUser.content, flat, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(
			query,
			lastUser.content,
			Math.max(256, this.config.recallMaxContentChars * 4),
		);
		const [recall, sessionContext] = await Promise.all([
			this.recallForContext(truncated),
			this.client.getSessionContext(sessionId, this.config.recallTokenBudget),
		]);
		if (!this.isReady || this.sessionId !== sessionId || this.#sessionEpoch !== epoch) return undefined;
		return (
			[
				recall,
				sessionContext
					? `<openviking-session-context>\n${sessionContext}\n</openviking-session-context>`
					: undefined,
			]
				.filter((part): part is string => typeof part === "string" && part.length > 0)
				.join("\n\n") || undefined
		);
	}

	async maybeRetainOnAgentEnd(_messages: AgentMessage[]): Promise<void> {
		if (
			!this.config.autoRetain ||
			this.aliasOf ||
			this.session.settings.get("memory.backend") !== "openviking" ||
			!this.#acceptWrites
		)
			return;
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		await this.#serialize(async () => {
			if (!this.#acceptWrites || !this.#readyEpochs.has(epoch)) return;
			const messages = this.#activeMessages();
			await this.#captureAndMaybeCommit(sessionId, messages, false, true, epoch);
		});
	}

	async flushAndCommit(): Promise<boolean> {
		if (this.aliasOf || !this.#acceptWrites) return true;
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		return await this.#serialize(async () => {
			if (!this.#readyEpochs.has(epoch)) return false;
			const messages = this.#activeMessages();
			const captureNew = this.config.autoRetain && this.session.settings.get("memory.backend") === "openviking";
			return await this.#captureAndMaybeCommit(sessionId, messages, true, captureNew, epoch);
		});
	}

	async commit(): Promise<boolean> {
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		return await this.#serialize(async () => {
			const outcome = await this.#archivePendingMessages(
				sessionId,
				this.lastCapturedMessageCount,
				this.lastCommittedTurn,
			);
			if (outcome.status === "accepted") this.#startExtractionMonitor(outcome.pending, sessionId, epoch);
			if (outcome.status === "unknown") this.#startCommitRecoveryMonitor(sessionId, epoch);
			return outcome.status === "accepted" || outcome.status === "skipped";
		});
	}

	async retainMessages(messages: Array<{ role: string; content: string }>): Promise<boolean> {
		const sessionId = this.sessionId;
		const epoch = this.#sessionEpoch;
		return await this.#serialize(async () => {
			if (this.#commitTaskBaseline !== null) {
				const recovery = await this.#archivePendingMessages(
					sessionId,
					this.lastCapturedMessageCount,
					this.lastCommittedTurn,
				);
				if (recovery.status === "accepted") {
					this.#startExtractionMonitor(recovery.pending, sessionId, epoch);
				} else if (recovery.status === "orphaned") {
					this.session.emitNotice("warning", `${recovery.error}: ${recovery.archiveUri}`, "OpenViking");
				} else {
					if (recovery.status === "unknown") this.#startCommitRecoveryMonitor(sessionId, epoch);
					return false;
				}
			}
			const retained = await this.#retainMessages(sessionId, messages);
			if (retained && this.#pendingCommit) this.#persistCaptureCursor(sessionId);
			return retained;
		});
	}

	async #retainMessages(sessionId: string, messages: Array<{ role: string; content: string }>): Promise<boolean> {
		const normalized = messages
			.map(message => ({ role: normalizeRole(message.role), content: stripInjectedBlocks(message.content).trim() }))
			.filter(
				(message): message is { role: CapturedRole; content: string } =>
					message.role !== null &&
					message.content.length > 0 &&
					(this.config.captureAssistantTurns || message.role === "user"),
			);
		for (const message of normalized) {
			const response = await this.client.addMessage(sessionId, {
				role: message.role,
				content: message.content,
			});
			if (!response.ok) {
				logger.warn("OpenViking: add message failed", { sessionId, error: response.error });
				return false;
			}
			this.#pendingCommit = true;
		}
		return true;
	}

	async #archivePendingMessages(
		sessionId: string,
		throughMessageCount: number,
		throughUserTurns: number,
	): Promise<OpenVikingArchiveOutcome> {
		const hadCommitTaskBaseline = this.#commitTaskBaseline !== null;
		if (hadCommitTaskBaseline) {
			const recovery = await this.#recoverCommitTask(sessionId);
			if (recovery.status !== "none") return recovery;
			return {
				status: "unknown",
				error: "OpenViking has not exposed a task for the previous commit attempt yet",
			};
		}

		if (this.#commitTaskBaseline === null && typeof this.client.listCommitTasks === "function") {
			const [baseline, sessionResponse] = await Promise.all([
				this.client.listCommitTasks(sessionId),
				typeof this.client.getSession === "function" ? this.client.getSession(sessionId, false) : null,
			]);
			if (!baseline.ok || !baseline.result) {
				return {
					status: "unknown",
					error:
						baseline.error ??
						(baseline.status === undefined
							? "OpenViking could not establish a commit task baseline"
							: `OpenViking could not establish a commit task baseline (HTTP ${baseline.status})`),
				};
			}
			let sessionMarker: OpenVikingSessionCommitMarker | null = null;
			if (sessionResponse) {
				if (!sessionResponse.ok || !sessionResponse.result) {
					return {
						status: "unknown",
						error:
							sessionResponse.error ??
							(sessionResponse.status === undefined
								? "OpenViking could not establish a session commit baseline"
								: `OpenViking could not establish a session commit baseline (HTTP ${sessionResponse.status})`),
					};
				}
				sessionMarker = parseSessionCommitMarker(sessionResponse.result, sessionId);
				if (!sessionMarker) {
					return { status: "unknown", error: "OpenViking returned an invalid session commit baseline" };
				}
			}
			this.#commitTaskBaseline = {
				taskIds: baseline.result.map(task => task.task_id),
				preparedAt: Date.now(),
				commitCount: sessionMarker?.commitCount ?? null,
				sessionUri: sessionMarker?.sessionUri ?? null,
				throughMessageCount,
				throughUserTurns,
			};
			if (!this.#persistCaptureCursor(sessionId)) {
				this.#commitTaskBaseline = null;
				return {
					status: "failed",
					error: "OpenViking commit was not sent because its task-recovery cursor could not be saved.",
				};
			}
		}
		const commitBaseline = this.#commitTaskBaseline ?? {
			taskIds: [],
			preparedAt: Date.now(),
			commitCount: null,
			sessionUri: null,
			throughMessageCount,
			throughUserTurns,
		};

		const response = await this.client.commitSession(sessionId);
		if (!response.ok || !response.result) {
			const error = response.error ?? `OpenViking commit failed (HTTP ${response.status ?? "unknown"}).`;
			logger.warn("OpenViking: commit failed", { sessionId, error });
			if (
				response.status === undefined ||
				response.status >= 500 ||
				(response.status >= 200 && response.status < 300)
			) {
				const recovery = await this.#recoverCommitTask(sessionId);
				if (recovery.status === "accepted") return recovery;
				if (recovery.status === "orphaned") return recovery;
				if (recovery.status === "blocked") return recovery;
				if (recovery.status === "unknown") {
					return {
						status: "unknown",
						error: `OpenViking commit acceptance is unknown (${error}); ${recovery.error}`,
					};
				}
				return { status: "unknown", error: `OpenViking commit acceptance is unknown (${error}).` };
			}
			this.#commitTaskBaseline = null;
			this.#persistCaptureCursor(sessionId);
			return { status: "failed", error };
		}
		const result: OpenVikingCommitStart = response.result;
		if (result.status === "skipped") {
			const recovery = await this.#recoverCommitTask(sessionId);
			if (recovery.status === "accepted") return recovery;
			if (recovery.status === "orphaned") return recovery;
			if (recovery.status === "blocked") return recovery;
			if (recovery.status === "unknown") return recovery;
			this.#pendingCommit = false;
			this.#commitTaskBaseline = null;
			this.lastCommittedTurn = commitBaseline.throughUserTurns;
			if (!this.#persistCaptureCursor(sessionId)) {
				logger.warn("OpenViking: skipped commit cursor could not be persisted", {
					sessionId,
					reason: result.reason,
				});
			}
			return { status: "skipped", reason: result.reason };
		}
		return this.#recordPendingExtraction(
			{
				taskId: result.task_id,
				archiveUri: result.archive_uri,
				acceptedAt: Date.now(),
				throughMessageCount: commitBaseline.throughMessageCount,
				throughUserTurns: commitBaseline.throughUserTurns,
			},
			sessionId,
		);
	}

	async #recoverCommitTask(sessionId: string): Promise<OpenVikingCommitTaskRecovery> {
		const baseline = this.#commitTaskBaseline;
		if (baseline === null || typeof this.client.listCommitTasks !== "function") return { status: "none" };
		const response = await this.client.listCommitTasks(sessionId);
		if (!response.ok || !response.result) {
			return {
				status: "unknown",
				error:
					response.error ??
					(response.status === undefined
						? "OpenViking commit task reconciliation failed"
						: `OpenViking commit task reconciliation failed (HTTP ${response.status})`),
			};
		}
		const baselineIds = new Set(baseline.taskIds);
		const candidates = response.result.filter(task => !baselineIds.has(task.task_id));
		if (candidates.length === 0) {
			const expiresAfterMs = Math.max(300_000, this.config.captureTimeoutMs * 4);
			const expired = Date.now() - baseline.preparedAt >= expiresAfterMs;
			if (
				baseline.commitCount !== null &&
				baseline.sessionUri !== null &&
				typeof this.client.getSession === "function"
			) {
				const sessionResponse = await this.client.getSession(sessionId, false);
				if (!sessionResponse.ok || !sessionResponse.result) {
					return {
						status: "unknown",
						error:
							sessionResponse.error ??
							(sessionResponse.status === undefined
								? "OpenViking session reconciliation failed"
								: `OpenViking session reconciliation failed (HTTP ${sessionResponse.status})`),
					};
				}
				const sessionMarker = parseSessionCommitMarker(sessionResponse.result, sessionId);
				if (!sessionMarker || sessionMarker.sessionUri !== baseline.sessionUri) {
					return { status: "unknown", error: "OpenViking returned an invalid session reconciliation marker" };
				}
				if (
					sessionMarker.commitCount < baseline.commitCount ||
					sessionMarker.commitCount > baseline.commitCount + 1
				) {
					return {
						status: "unknown",
						error: "OpenViking session commit_count changed by an ambiguous amount during reconciliation",
					};
				}
				const phaseOneApplied = sessionMarker.commitCount === baseline.commitCount + 1;
				if (phaseOneApplied) {
					if (!expired) return { status: "none" };
					const archiveIndex = Math.max(sessionMarker.commitCount, baseline.commitCount + 1);
					const archiveUri = `${baseline.sessionUri.replace(/\/$/, "")}/history/archive_${String(archiveIndex).padStart(3, "0")}`;
					this.#pendingCommit = false;
					this.#commitTaskBaseline = null;
					this.lastCommittedTurn = baseline.throughUserTurns;
					this.#persistCaptureCursor(sessionId);
					return {
						status: "orphaned",
						archiveUri,
						error: "OpenViking archived the pending tail but exposed no extraction task before the recovery window expired",
					};
				}
			}
			if (!expired) return { status: "none" };
			return {
				status: "blocked",
				error: "OpenViking exposed no task and no persisted Phase 1 evidence before the recovery window expired; the commit cannot be retried safely without an idempotency key",
			};
		}
		if (candidates.length > 1) {
			return {
				status: "unknown",
				error: `OpenViking found ${candidates.length} new commit tasks for the session and could not identify the matching task safely`,
			};
		}
		const task = candidates[0];
		if (!task) return { status: "none" };
		return this.#recordPendingExtraction(
			{
				taskId: task.task_id,
				archiveUri: taskArchiveUri(task),
				acceptedAt:
					typeof task.created_at === "number" && Number.isFinite(task.created_at)
						? Math.max(0, task.created_at * 1_000)
						: Date.now(),
				throughMessageCount: baseline.throughMessageCount,
				throughUserTurns: baseline.throughUserTurns,
			},
			sessionId,
		);
	}

	#recordPendingExtraction(pending: OpenVikingPendingExtraction, sessionId: string): OpenVikingArchiveAccepted {
		this.#pendingCommit = false;
		this.#commitTaskBaseline = null;
		this.lastCommittedTurn = pending.throughUserTurns;
		if (!this.#pendingExtractions.some(item => item.taskId === pending.taskId)) {
			this.#pendingExtractions.push(pending);
		}
		if (!this.#persistCaptureCursor(sessionId)) {
			logger.warn("OpenViking: accepted commit task cursor could not be persisted", {
				sessionId,
				taskId: pending.taskId,
			});
		}
		return { status: "accepted", pending };
	}

	async #waitForExplicitExtraction(
		pending: OpenVikingPendingExtraction,
		sessionId: string,
		epoch: number,
		signal: AbortSignal,
	): Promise<OpenVikingSaveOutcome> {
		let result: OpenVikingTaskWaitResult;
		try {
			result = await this.client.waitForCommitTask(pending.taskId, {
				timeoutMs: this.config.captureTimeoutMs,
				signal,
				expectedResourceId: sessionId,
				...(pending.archiveUri === null ? {} : { expectedArchiveUri: pending.archiveUri }),
			});
		} catch (error) {
			this.#startExtractionMonitor(pending, sessionId, epoch);
			return {
				status: "queued",
				taskId: pending.taskId,
				...(pending.archiveUri === null ? {} : { archiveUri: pending.archiveUri }),
				reason: "unknown",
				message: `OpenViking archived the write, but extraction status could not be checked: ${String(error)}`,
			};
		}
		if (result.status === "completed") {
			const archiveUri = pending.archiveUri ?? taskArchiveUri(result.task);
			if (!archiveUri) {
				const error = "completed commit task did not report archive_uri";
				await this.#abandonUnverifiableExtraction(pending, error, sessionId, epoch);
				return { status: "failed", error: `OpenViking extraction task validation failed: ${error}` };
			}
			await this.#settleExtraction(pending, result, sessionId, epoch);
			const extracted = countExtractedMemories(result);
			if (extracted && extracted > 0) {
				return { status: "stored", taskId: pending.taskId, archiveUri, extracted };
			}
			return {
				status: "completed",
				taskId: pending.taskId,
				archiveUri,
				...(extracted === undefined ? {} : { extracted }),
			};
		}
		if (result.status === "failed") {
			await this.#settleExtraction(pending, result, sessionId, epoch);
			return { status: "failed", error: `OpenViking memory extraction failed: ${result.error}` };
		}
		if (result.status === "unknown" && result.reason === "protocol") {
			await this.#abandonUnverifiableExtraction(pending, result.error, sessionId, epoch);
			return { status: "failed", error: `OpenViking extraction task validation failed: ${result.error}` };
		}
		this.#startExtractionMonitor(pending, sessionId, epoch);
		return {
			status: "queued",
			taskId: pending.taskId,
			...(pending.archiveUri === null ? {} : { archiveUri: pending.archiveUri }),
			reason: result.status,
			message:
				result.status === "unknown"
					? `OpenViking archived the write, but extraction status is temporarily unknown: ${result.error}`
					: result.status === "aborted"
						? "OpenViking archived the write, but the extraction status check was interrupted."
						: "OpenViking archived the write and memory extraction is still queued.",
		};
	}

	#startPendingExtractionMonitors(sessionId = this.sessionId, epoch = this.#sessionEpoch): void {
		if (!this.#monitoringEnabled || !this.#acceptWrites) return;
		this.#startCommitRecoveryMonitor(sessionId, epoch);
		for (const pending of this.#pendingExtractions) this.#startExtractionMonitor(pending, sessionId, epoch);
	}

	#startCommitRecoveryMonitor(sessionId = this.sessionId, epoch = this.#sessionEpoch): void {
		const monitorKey = `${epoch}\0commit`;
		if (
			!this.#monitoringEnabled ||
			!this.#acceptWrites ||
			this.sessionId !== sessionId ||
			this.#sessionEpoch !== epoch ||
			this.#commitTaskBaseline === null ||
			this.#commitRecoveryMonitorKeys.has(monitorKey)
		)
			return;
		this.#commitRecoveryMonitorKeys.add(monitorKey);
		const signal = this.#monitorAbortController.signal;
		void (async () => {
			let reportedUnavailable = false;
			while (
				this.#acceptWrites &&
				!signal.aborted &&
				this.sessionId === sessionId &&
				this.#sessionEpoch === epoch &&
				this.#commitTaskBaseline !== null
			) {
				const recovery = await this.#serialize(async () => {
					if (
						!this.#acceptWrites ||
						signal.aborted ||
						this.sessionId !== sessionId ||
						this.#sessionEpoch !== epoch
					) {
						return { status: "none" } as const;
					}
					return await this.#recoverCommitTask(sessionId);
				});
				if (recovery.status === "accepted") {
					this.session.emitNotice(
						"info",
						"OpenViking recovered the commit task whose response was unavailable.",
						"OpenViking",
					);
					this.#startExtractionMonitor(recovery.pending, sessionId, epoch);
					return;
				}
				if (recovery.status === "orphaned") {
					logger.warn("OpenViking: archived commit has no verifiable extraction task", {
						sessionId,
						archiveUri: recovery.archiveUri,
					});
					this.session.emitNotice("warning", `${recovery.error}: ${recovery.archiveUri}`, "OpenViking");
					return;
				}
				if (recovery.status === "blocked") {
					logger.warn("OpenViking: ambiguous commit requires manual reconciliation", {
						sessionId,
						error: recovery.error,
					});
					this.session.emitNotice("warning", recovery.error, "OpenViking");
					return;
				}
				if (recovery.status === "unknown" && !reportedUnavailable) {
					reportedUnavailable = true;
					logger.warn("OpenViking: commit task reconciliation is temporarily unavailable", {
						sessionId,
						error: recovery.error,
					});
					this.session.emitNotice(
						"warning",
						`OpenViking commit task reconciliation is temporarily unavailable: ${recovery.error}`,
						"OpenViking",
					);
				}
				if (!(await sleepWithAbort(Math.min(30_000, Math.max(1_000, this.config.captureTimeoutMs)), signal))) {
					return;
				}
			}
		})()
			.catch(error => {
				logger.warn("OpenViking: commit task reconciliation monitor failed", {
					sessionId,
					error: String(error),
				});
			})
			.finally(() => this.#commitRecoveryMonitorKeys.delete(monitorKey));
	}

	#startExtractionMonitor(
		pending: OpenVikingPendingExtraction,
		sessionId = this.sessionId,
		epoch = this.#sessionEpoch,
	): void {
		const monitorKey = `${epoch}\0${pending.taskId}`;
		if (
			!this.#monitoringEnabled ||
			!this.#acceptWrites ||
			this.sessionId !== sessionId ||
			this.#sessionEpoch !== epoch ||
			this.#monitoredTaskIds.has(monitorKey)
		)
			return;
		this.#monitoredTaskIds.add(monitorKey);
		const signal = this.#monitorAbortController.signal;
		void (async () => {
			let reportedUnknown = false;
			let notFoundCount = 0;
			while (this.#acceptWrites && !signal.aborted && this.sessionId === sessionId && this.#sessionEpoch === epoch) {
				const result = await this.client.waitForCommitTask(pending.taskId, {
					timeoutMs: this.config.captureTimeoutMs,
					signal,
					expectedResourceId: sessionId,
					...(pending.archiveUri === null ? {} : { expectedArchiveUri: pending.archiveUri }),
				});
				if (result.status === "timeout") continue;
				if (result.status === "unknown") {
					if (result.reason === "protocol") {
						await this.#abandonUnverifiableExtraction(pending, result.error, sessionId, epoch);
						return;
					}
					if (result.reason === "not_found") {
						notFoundCount += 1;
						if (notFoundCount >= 3) {
							await this.#abandonUnverifiableExtraction(pending, result.error, sessionId, epoch);
							return;
						}
					} else {
						notFoundCount = 0;
					}
					if (!reportedUnknown) {
						reportedUnknown = true;
						logger.warn("OpenViking: extraction task status is temporarily unavailable", {
							sessionId,
							taskId: pending.taskId,
							error: result.error,
						});
						this.session.emitNotice(
							"warning",
							`OpenViking archived the session, but extraction status is temporarily unavailable: ${result.error}`,
							"OpenViking",
						);
					}
					await Bun.sleep(Math.min(30_000, Math.max(1_000, this.config.captureTimeoutMs)));
					continue;
				}
				if (result.status === "aborted") return;
				if (result.status === "completed" && !pending.archiveUri && !taskArchiveUri(result.task)) {
					await this.#abandonUnverifiableExtraction(
						pending,
						"completed commit task did not report archive_uri",
						sessionId,
						epoch,
					);
					return;
				}
				await this.#settleExtraction(pending, result, sessionId, epoch);
				return;
			}
		})()
			.catch(error => {
				logger.warn("OpenViking: extraction task monitor failed", {
					sessionId,
					taskId: pending.taskId,
					error: String(error),
				});
			})
			.finally(() => this.#monitoredTaskIds.delete(monitorKey));
	}

	async #settleExtraction(
		pending: OpenVikingPendingExtraction,
		result: Extract<OpenVikingTaskWaitResult, { status: "completed" | "failed" }>,
		sessionId: string,
		epoch: number,
	): Promise<void> {
		await this.#serialize(async () => {
			if (!this.#acceptWrites || this.sessionId !== sessionId || this.#sessionEpoch !== epoch) return;
			const index = this.#pendingExtractions.findIndex(item => item.taskId === pending.taskId);
			if (index < 0) return;
			this.#pendingExtractions.splice(index, 1);
			this.#persistCaptureCursor(sessionId);
			if (result.status === "failed") {
				this.session.emitNotice(
					"warning",
					`OpenViking archived the session, but memory extraction failed: ${result.error}`,
					"OpenViking",
				);
			}
		});
	}

	async #abandonUnverifiableExtraction(
		pending: OpenVikingPendingExtraction,
		error: string,
		sessionId: string,
		epoch: number,
	): Promise<void> {
		await this.#serialize(async () => {
			if (!this.#acceptWrites || this.sessionId !== sessionId || this.#sessionEpoch !== epoch) return;
			const index = this.#pendingExtractions.findIndex(item => item.taskId === pending.taskId);
			if (index < 0) return;
			this.#pendingExtractions.splice(index, 1);
			this.#persistCaptureCursor(sessionId);
			this.session.emitNotice(
				"warning",
				`OpenViking archived the session, but its extraction task can no longer be verified: ${error}`,
				"OpenViking",
			);
		});
	}

	#resetExtractionMonitors(): void {
		this.#monitorAbortController.abort();
		this.#monitorAbortController = new AbortController();
		this.#commitRecoveryMonitorKeys.clear();
		this.#monitoredTaskIds.clear();
	}

	async #captureAndMaybeCommit(
		sessionId: string,
		messages: Array<{ role: string; content: string }>,
		forceCommit: boolean,
		captureNew = true,
		epoch = this.#sessionEpoch,
	): Promise<boolean> {
		if (this.#commitTaskBaseline !== null) {
			const recovery = await this.#archivePendingMessages(
				sessionId,
				this.lastCapturedMessageCount,
				this.lastCommittedTurn,
			);
			if (recovery.status === "accepted") {
				this.#startExtractionMonitor(recovery.pending, sessionId, epoch);
			} else if (recovery.status === "orphaned") {
				this.session.emitNotice("warning", `${recovery.error}: ${recovery.archiveUri}`, "OpenViking");
			} else if (recovery.status === "blocked") {
				this.session.emitNotice("warning", recovery.error, "OpenViking");
				return false;
			} else if (recovery.status === "unknown") {
				this.#startCommitRecoveryMonitor(sessionId, epoch);
				return false;
			} else if (recovery.status === "failed") {
				return false;
			}
		}
		let cursorPersisted = true;
		if (messages.length < this.lastCapturedMessageCount) {
			this.lastCapturedMessageCount = messages.length;
			this.lastCommittedTurn = messages.filter(message => message.role === "user").length;
			cursorPersisted = this.#persistCaptureCursor(sessionId);
		}

		let captureComplete = !captureNew || this.lastCapturedMessageCount >= messages.length;
		if (captureNew && cursorPersisted) {
			captureComplete = true;
			for (let index = this.lastCapturedMessageCount; index < messages.length; index += 1) {
				if (!this.#acceptWrites) return false;
				const message = messages[index];
				if (!message) continue;
				const role = normalizeRole(message.role);
				const content = stripInjectedBlocks(message.content).trim();
				if (role && content && (this.config.captureAssistantTurns || role === "user")) {
					const response = await this.client.addMessage(sessionId, { role, content });
					if (!response.ok) {
						logger.warn("OpenViking: add message failed", { sessionId, error: response.error });
						captureComplete = false;
						break;
					}
					this.#pendingCommit = true;
				}
				this.lastCapturedMessageCount = index + 1;
				if (!this.#persistCaptureCursor(sessionId)) {
					cursorPersisted = false;
					captureComplete = false;
					break;
				}
			}
		}

		const capturedUserTurns = messages
			.slice(0, this.lastCapturedMessageCount)
			.filter(message => message.role === "user").length;
		const commitThresholdReached = capturedUserTurns - this.lastCommittedTurn >= this.config.commitEveryNTurns;
		if (!this.#pendingCommit || (!forceCommit && !commitThresholdReached)) {
			return captureComplete && cursorPersisted;
		}
		const archive = await this.#archivePendingMessages(sessionId, this.lastCapturedMessageCount, capturedUserTurns);
		if (archive.status === "failed") return false;
		if (archive.status === "unknown") {
			this.#startCommitRecoveryMonitor(sessionId, epoch);
			return false;
		}
		if (archive.status === "accepted") this.#startExtractionMonitor(archive.pending, sessionId, epoch);
		if (archive.status === "orphaned") {
			this.session.emitNotice("warning", `${archive.error}: ${archive.archiveUri}`, "OpenViking");
		}
		if (archive.status === "blocked") return false;
		return captureComplete && cursorPersisted;
	}

	#activeMessages(): Array<{ role: string; content: string }> {
		return extractMessages({ getEntries: () => this.session.sessionManager.getBranch() });
	}

	/**
	 * Seed the destination workspace scope at the current transcript boundary.
	 * Historical turns must not be replayed into a different workspace merely
	 * because `/move` changed cwd. The old scope keeps its own cursor so any tail
	 * that could not be flushed remains recoverable if that workspace is resumed.
	 */
	baselineWorkspaceTransition(nextConfig: OpenVikingConfig, sourceFlushed: boolean): boolean {
		const currentIdentity = this.#captureCursorIdentity(this.sessionId);
		const nextIdentity = this.#captureCursorIdentity(this.sessionId, nextConfig);
		const workspaceChanged = this.#workspaceCwd !== this.session.settings.getCwd();
		if (!workspaceChanged) return true;
		if (!sourceFlushed) return false;
		if (cursorIdentityEquals(currentIdentity, nextIdentity)) return true;

		const messages = this.#activeMessages();
		try {
			this.session.sessionManager.appendCustomEntry(OPENVIKING_CAPTURE_CURSOR_TYPE, {
				version: OPENVIKING_CAPTURE_CURSOR_VERSION,
				identity: nextIdentity,
				capturedMessageCount: messages.length,
				archivedUserTurns: messages.filter(message => message.role === "user").length,
				hasUnarchivedRemoteMessages: false,
				commitTaskBaseline: null,
				pendingExtractions: [],
			} satisfies OpenVikingCaptureCursor);
			return true;
		} catch (error) {
			logger.warn("OpenViking: workspace transition baseline persistence failed", {
				sessionId: this.sessionId,
				error: String(error),
			});
			return false;
		}
	}

	#captureCursorIdentity(sessionId: string, config: OpenVikingConfig = this.config): OpenVikingCursorIdentity {
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		return {
			baseUrl,
			credentialFingerprint: fingerprintCredential(baseUrl, config.apiKey),
			accountId: config.accountId,
			userId: config.userId,
			peerId: config.peerId,
			sessionId,
		};
	}

	#loadCaptureCursor(sessionId: string): OpenVikingCaptureCursor | undefined {
		const expectedIdentity = this.#captureCursorIdentity(sessionId);
		const branch = this.session.sessionManager.getBranch();
		let cwdTransitionIndex = -1;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (
				entry.type === "custom" &&
				entry.customType === SESSION_CWD_TRANSITION_CUSTOM_TYPE &&
				entry.data &&
				typeof entry.data === "object" &&
				(entry.data as Record<string, unknown>).version === 1
			) {
				cwdTransitionIndex = index;
				break;
			}
		}
		let workspaceUpgrade: OpenVikingCaptureCursor | undefined;
		let sawNewerScopedCursor = false;
		for (let index = branch.length - 1; index > cwdTransitionIndex; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== OPENVIKING_CAPTURE_CURSOR_TYPE) continue;
			const data = parseCaptureCursor(entry.data);
			if (data && cursorIdentityEquals(data.identity, expectedIdentity)) return data;
			if (!data || !cursorConnectionIdentityEquals(data.identity, expectedIdentity)) continue;
			if (data.identity.peerId !== null) {
				sawNewerScopedCursor = true;
				continue;
			}
			if (
				!workspaceUpgrade &&
				!sawNewerScopedCursor &&
				this.config.peerSource === "workspace" &&
				expectedIdentity.peerId !== null &&
				data.identity.peerId === null
			) {
				workspaceUpgrade = data;
			}
		}
		if (workspaceUpgrade) return workspaceUpgrade;
		if (cwdTransitionIndex < 0) return undefined;
		const messagesBeforeTransition = extractMessages({ getEntries: () => branch.slice(0, cwdTransitionIndex) });
		return {
			version: OPENVIKING_CAPTURE_CURSOR_VERSION,
			identity: expectedIdentity,
			capturedMessageCount: messagesBeforeTransition.length,
			archivedUserTurns: messagesBeforeTransition.filter(message => message.role === "user").length,
			hasUnarchivedRemoteMessages: false,
			commitTaskBaseline: null,
			pendingExtractions: [],
		};
	}

	#persistCaptureCursor(sessionId: string): boolean {
		try {
			this.session.sessionManager.appendCustomEntry(OPENVIKING_CAPTURE_CURSOR_TYPE, {
				version: OPENVIKING_CAPTURE_CURSOR_VERSION,
				identity: this.#captureCursorIdentity(sessionId),
				capturedMessageCount: this.lastCapturedMessageCount,
				archivedUserTurns: this.lastCommittedTurn,
				hasUnarchivedRemoteMessages: this.#pendingCommit,
				commitTaskBaseline: this.#commitTaskBaseline
					? { ...this.#commitTaskBaseline, taskIds: [...this.#commitTaskBaseline.taskIds] }
					: null,
				pendingExtractions: this.#pendingExtractions.map(pending => ({ ...pending })),
			} satisfies OpenVikingCaptureCursor);
			return true;
		} catch (error) {
			logger.warn("OpenViking: capture cursor persistence failed", { sessionId, error: String(error) });
			return false;
		}
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#operationTail.then(operation);
		this.#operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async formatItems(items: readonly OpenVikingSearchItem[], includeIds = false): Promise<string | undefined> {
		if (!this.isReady || items.length === 0) return undefined;
		let budgetRemaining = this.config.recallTokenBudget;
		const lines = ["<openviking-context>", OPENVIKING_CONTEXT_HEADER];
		for (const item of items) {
			if (!this.isReady) return undefined;
			const score =
				typeof item.score === "number" ? ` ${(Math.max(0, Math.min(1, item.score)) * 100).toFixed(0)}%` : "";
			const source = recallSourceLabel(item);
			const memoryUri = memoryUriFromOpenVikingUri(item.uri);
			const uriLine = `- [${source}${score}] ${memoryUri}${includeIds ? ` (id: ${memoryUri})` : ""}`;
			if (budgetRemaining <= 0) {
				lines.push(uriLine);
				continue;
			}
			const content = await this.resolveItemContent(item);
			const contentLine = `- [${source}${score}] ${content}${includeIds ? ` (id: ${memoryUri})` : ""}`;
			const lineTokens = estimateTokens(contentLine);
			if (lineTokens > budgetRemaining && lines.length > 2) {
				lines.push(uriLine);
				continue;
			}
			lines.push(contentLine);
			budgetRemaining -= lineTokens;
		}
		if (!this.isReady) return undefined;
		lines.push("</openviking-context>");
		return lines.join("\n");
	}

	async resolveItemContent(item: OpenVikingSearchItem): Promise<string> {
		const memoryUri = memoryUriFromOpenVikingUri(item.uri);
		const abstract = (item.abstract || item.overview || "").trim();
		const serverSummary = typeof item.summary === "string" ? item.summary.trim() : "";
		const recalledContent = typeof item.content === "string" ? item.content.trim() : "";
		let content: string;
		switch (item.mode) {
			case "full":
				content = recalledContent || serverSummary || abstract || memoryUri;
				break;
			case "summary":
				content = serverSummary || abstract || memoryUri;
				break;
			case "uri":
				content = memoryUri;
				break;
			default: {
				const summary = abstract || serverSummary;
				if (this.config.recallPreferAbstract && summary) {
					content = summary;
				} else if (recalledContent) {
					content = recalledContent;
				} else if (item.level === 2 || item.uri.endsWith(".md")) {
					content = (await this.client.readContent(item.uri))?.trim() || summary || memoryUri;
				} else {
					content = summary || memoryUri;
				}
			}
		}
		if (content.length > this.config.recallMaxContentChars) {
			return `${content.slice(0, this.config.recallMaxContentChars)}...`;
		}
		return content;
	}
}

function recallSourceLabel(item: OpenVikingSearchItem): string {
	if (item._sourceType === "skill") return "skill";
	switch (item.origin) {
		case "actor_peer":
			return "memory/current-project";
		case "self":
			return "memory/global";
		case "other_peer":
			return "memory/other-projects";
		default:
			return "memory";
	}
}

function parseCaptureCursor(value: unknown): OpenVikingCaptureCursor | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		(record.version !== 2 && record.version !== 3 && record.version !== OPENVIKING_CAPTURE_CURSOR_VERSION) ||
		!record.identity
	)
		return undefined;
	if (typeof record.identity !== "object") return undefined;
	const identity = record.identity as Record<string, unknown>;
	if (
		typeof identity.baseUrl !== "string" ||
		!isNullableString(identity.credentialFingerprint) ||
		!isNullableString(identity.accountId) ||
		!isNullableString(identity.userId) ||
		!isNullableString(identity.peerId) ||
		typeof identity.sessionId !== "string" ||
		!isNonNegativeInteger(record.capturedMessageCount)
	)
		return undefined;
	const parsedIdentity: OpenVikingCursorIdentity = {
		baseUrl: normalizeBaseUrl(identity.baseUrl),
		credentialFingerprint: identity.credentialFingerprint,
		accountId: identity.accountId,
		userId: identity.userId,
		peerId: identity.peerId,
		sessionId: identity.sessionId,
	};
	if (record.version === 2) {
		if (!isNonNegativeInteger(record.committedUserTurns) || typeof record.pendingCommit !== "boolean") {
			return undefined;
		}
		return {
			version: OPENVIKING_CAPTURE_CURSOR_VERSION,
			identity: parsedIdentity,
			capturedMessageCount: record.capturedMessageCount,
			archivedUserTurns: record.committedUserTurns,
			hasUnarchivedRemoteMessages: record.pendingCommit,
			commitTaskBaseline: null,
			pendingExtractions: [],
		};
	}
	if (
		!isNonNegativeInteger(record.archivedUserTurns) ||
		typeof record.hasUnarchivedRemoteMessages !== "boolean" ||
		!Array.isArray(record.pendingExtractions)
	) {
		return undefined;
	}
	let commitTaskBaseline: OpenVikingCommitTaskBaseline | null = null;
	if (record.version === OPENVIKING_CAPTURE_CURSOR_VERSION) {
		if (record.commitTaskBaseline !== null) {
			if (
				!record.commitTaskBaseline ||
				typeof record.commitTaskBaseline !== "object" ||
				Array.isArray(record.commitTaskBaseline)
			) {
				return undefined;
			}
			const baseline = record.commitTaskBaseline as Record<string, unknown>;
			const hasSessionMarker =
				(baseline.commitCount !== undefined && baseline.commitCount !== null) ||
				(baseline.sessionUri !== undefined && baseline.sessionUri !== null);
			if (
				!Array.isArray(baseline.taskIds) ||
				baseline.taskIds.some(taskId => typeof taskId !== "string" || !taskId) ||
				typeof baseline.preparedAt !== "number" ||
				!Number.isFinite(baseline.preparedAt) ||
				baseline.preparedAt < 0 ||
				!isNonNegativeInteger(baseline.throughMessageCount) ||
				!isNonNegativeInteger(baseline.throughUserTurns) ||
				(hasSessionMarker &&
					(!isNonNegativeInteger(baseline.commitCount) ||
						typeof baseline.sessionUri !== "string" ||
						!baseline.sessionUri.trim()))
			) {
				return undefined;
			}
			commitTaskBaseline = {
				taskIds: [...new Set(baseline.taskIds)],
				preparedAt: baseline.preparedAt,
				commitCount: hasSessionMarker ? (baseline.commitCount as number) : null,
				sessionUri: hasSessionMarker ? (baseline.sessionUri as string) : null,
				throughMessageCount: baseline.throughMessageCount,
				throughUserTurns: baseline.throughUserTurns,
			};
		}
	}
	const pendingExtractions: OpenVikingPendingExtraction[] = [];
	for (const pending of record.pendingExtractions) {
		const parsed = parsePendingExtraction(pending, record.version === OPENVIKING_CAPTURE_CURSOR_VERSION);
		if (!parsed) return undefined;
		pendingExtractions.push(parsed);
	}
	return {
		version: OPENVIKING_CAPTURE_CURSOR_VERSION,
		identity: parsedIdentity,
		capturedMessageCount: record.capturedMessageCount,
		archivedUserTurns: record.archivedUserTurns,
		hasUnarchivedRemoteMessages: record.hasUnarchivedRemoteMessages,
		commitTaskBaseline,
		pendingExtractions,
	};
}

function parsePendingExtraction(
	value: unknown,
	allowUnknownArchiveUri: boolean,
): OpenVikingPendingExtraction | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.taskId !== "string" ||
		!record.taskId ||
		(record.archiveUri !== null && (typeof record.archiveUri !== "string" || !record.archiveUri)) ||
		(!allowUnknownArchiveUri && record.archiveUri === null) ||
		typeof record.acceptedAt !== "number" ||
		!Number.isFinite(record.acceptedAt) ||
		record.acceptedAt < 0 ||
		!isNonNegativeInteger(record.throughMessageCount) ||
		!isNonNegativeInteger(record.throughUserTurns)
	) {
		return undefined;
	}
	return {
		taskId: record.taskId,
		archiveUri: record.archiveUri as string | null,
		acceptedAt: record.acceptedAt,
		throughMessageCount: record.throughMessageCount,
		throughUserTurns: record.throughUserTurns,
	};
}

function taskArchiveUri(task: OpenVikingTask): string | null {
	const archiveUri = task.result?.archive_uri;
	return typeof archiveUri === "string" && archiveUri.trim() ? archiveUri : null;
}

function parseSessionCommitMarker(value: unknown, expectedSessionId: string): OpenVikingSessionCommitMarker | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record.session_id !== expectedSessionId ||
		typeof record.uri !== "string" ||
		!record.uri.trim() ||
		!isNonNegativeInteger(record.commit_count)
	) {
		return null;
	}
	return { commitCount: record.commit_count, sessionUri: record.uri };
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return false;
	const settled = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => settled.resolve(true), ms);
	timer.unref();
	const onAbort = () => settled.resolve(false);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await settled.promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

function countExtractedMemories(
	result: Extract<OpenVikingTaskWaitResult, { status: "completed" }>,
): number | undefined {
	const counts = result.task.result?.memories_extracted;
	if (!counts || typeof counts !== "object" || Array.isArray(counts)) return undefined;
	const record = counts as Record<string, unknown>;
	if (typeof record.total === "number" && Number.isFinite(record.total)) {
		return Math.max(0, Math.floor(record.total));
	}
	let total = 0;
	for (const value of Object.values(record)) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += Math.floor(value);
	}
	return total;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function cursorIdentityEquals(a: OpenVikingCursorIdentity, b: OpenVikingCursorIdentity): boolean {
	return cursorConnectionIdentityEquals(a, b) && a.peerId === b.peerId;
}

function cursorConnectionIdentityEquals(a: OpenVikingCursorIdentity, b: OpenVikingCursorIdentity): boolean {
	return (
		a.baseUrl === b.baseUrl &&
		a.credentialFingerprint === b.credentialFingerprint &&
		a.accountId === b.accountId &&
		a.userId === b.userId &&
		a.sessionId === b.sessionId
	);
}

function fingerprintCredential(baseUrl: string, value: string | null): string | null {
	if (!value) return null;
	return new Bun.CryptoHasher("sha256").update(`openviking-cursor\0${baseUrl}\0${value}`).digest("hex");
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function deriveOpenVikingSessionId(sessionId: string): string {
	return `${OPENVIKING_SESSION_PREFIX}${sessionId}`;
}

function normalizeRole(role: string): CapturedRole | null {
	if (role === "user" || role === "assistant") return role;
	return null;
}

const OPENVIKING_CTX_BLOCK_RE = /<openviking-context>[\s\S]*?<\/openviking-context>/gi;
const MEMORIES_BLOCK_RE = /<memories>[\s\S]*?<\/memories>/gi;
const HINDSIGHT_BLOCK_RE = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/gi;
const SYSTEM_REMINDER_BLOCK_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

function stripInjectedBlocks(text: string): string {
	return text
		.replace(OPENVIKING_CTX_BLOCK_RE, "")
		.replace(MEMORIES_BLOCK_RE, "")
		.replace(HINDSIGHT_BLOCK_RE, "")
		.replace(SYSTEM_REMINDER_BLOCK_RE, "")
		.replace(/\x00/g, "");
}

function estimateTokens(text: string): number {
	let cjk = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) >= 0x3000) cjk += 1;
	}
	return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
}

function flattenAgentMessages(messages: AgentMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
	const flattened: Array<{ role: "user" | "assistant"; content: string }> = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map(block => block.text)
						.join("\n");
		if (text.trim()) flattened.push({ role: message.role, content: text });
	}
	return flattened;
}
