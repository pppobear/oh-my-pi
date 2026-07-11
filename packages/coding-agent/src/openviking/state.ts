import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { composeRecallQuery, truncateRecallQuery } from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { OpenVikingApi, OpenVikingSearchItem } from "./client";
import type { OpenVikingConfig } from "./config";
import { memoryUriFromOpenVikingUri } from "./uri";

const kOpenVikingSessionState = Symbol("openviking.sessionState");
const OPENVIKING_SESSION_PREFIX = "omp-";
const OPENVIKING_CONTEXT_HEADER =
	"Relevant context from OpenViking. Use recall or read MCP tools to expand memory:// URIs.";

type CapturedRole = "user" | "assistant";

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

export class OpenVikingSessionState {
	sessionId: string;
	readonly config: OpenVikingConfig;
	readonly client: OpenVikingApi;
	readonly session: AgentSession;
	readonly aliasOf?: OpenVikingSessionState;
	lastRecallSnippet?: string;
	lastCapturedMessageCount: number;
	lastCommittedTurn: number;
	unsubscribe?: () => void;

	constructor(options: OpenVikingSessionStateOptions) {
		this.sessionId = deriveOpenVikingSessionId(options.sessionId);
		this.config = options.config;
		this.client = options.client;
		this.session = options.session;
		this.aliasOf = options.aliasOf;
		this.lastCapturedMessageCount = options.lastCapturedMessageCount ?? 0;
		this.lastCommittedTurn = options.lastCommittedTurn ?? 0;
	}

	setSessionId(sessionId: string): void {
		this.sessionId = deriveOpenVikingSessionId(sessionId);
	}

	resetConversationTracking(): void {
		this.lastRecallSnippet = undefined;
		this.lastCapturedMessageCount = 0;
		this.lastCommittedTurn = 0;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd(event.messages);
			}
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (!this.config.autoRecall) return undefined;
		const latestPrompt = promptText.trim();
		if (latestPrompt.length < this.config.minQueryLength) return undefined;
		const history = extractMessages(this.session.sessionManager);
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
			return await this.formatItems(filtered.length > 0 ? filtered : items.slice(0, 1));
		} catch (error) {
			logger.warn("OpenViking: recall failed", { sessionId: this.sessionId, error: String(error) });
			return undefined;
		}
	}

	async search(query: string, limit: number): Promise<OpenVikingSearchItem[]> {
		return await this.client.search(query, limit);
	}

	async save(content: string, context?: string): Promise<boolean> {
		const trimmed = content.trim();
		if (!trimmed) return false;
		const payload = context?.trim() ? `${trimmed}\n\nContext: ${context.trim()}` : trimmed;
		const response = await this.client.addMessage(this.sessionId, { role: "user", content: payload });
		if (!response.ok) return false;
		return await this.commit();
	}

	async forceRetainCurrentSession(): Promise<void> {
		if (this.aliasOf) return;
		const messages = extractMessages(this.session.sessionManager);
		if (!(await this.retainMessages(messages.slice(this.lastCapturedMessageCount)))) return;
		if (!(await this.commit())) return;
		this.lastCapturedMessageCount = messages.length;
	}

	async recallForCompaction(messages: AgentMessage[]): Promise<string | undefined> {
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
			this.client.getSessionContext(this.sessionId, this.config.recallTokenBudget),
		]);
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
		if (!this.config.autoRetain || this.aliasOf) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length <= this.lastCapturedMessageCount) return;
		if (!(await this.retainMessages(messages.slice(this.lastCapturedMessageCount)))) return;
		const userTurns = messages.filter(message => message.role === "user").length;
		if (userTurns - this.lastCommittedTurn >= this.config.commitEveryNTurns) {
			if (!(await this.commit())) return;
			this.lastCommittedTurn = userTurns;
		}
		this.lastCapturedMessageCount = messages.length;
	}

	async commit(): Promise<boolean> {
		const response = await this.client.commitSession(this.sessionId);
		if (!response.ok) {
			logger.warn("OpenViking: commit failed", { sessionId: this.sessionId, error: response.error });
			return false;
		}
		return true;
	}

	async retainMessages(messages: Array<{ role: string; content: string }>): Promise<boolean> {
		const normalized = messages
			.map(message => ({ role: normalizeRole(message.role), content: stripInjectedBlocks(message.content).trim() }))
			.filter(
				(message): message is { role: CapturedRole; content: string } =>
					message.role !== null &&
					message.content.length > 0 &&
					(this.config.captureAssistantTurns || message.role === "user"),
			);
		for (const message of normalized) {
			const response = await this.client.addMessage(this.sessionId, {
				role: message.role,
				content: message.content,
			});
			if (!response.ok) {
				logger.warn("OpenViking: add message failed", { sessionId: this.sessionId, error: response.error });
				return false;
			}
		}
		return true;
	}

	async formatItems(items: readonly OpenVikingSearchItem[], includeIds = false): Promise<string | undefined> {
		if (items.length === 0) return undefined;
		let budgetRemaining = this.config.recallTokenBudget;
		const lines = ["<openviking-context>", OPENVIKING_CONTEXT_HEADER];
		for (const item of items) {
			const score =
				typeof item.score === "number" ? ` ${(Math.max(0, Math.min(1, item.score)) * 100).toFixed(0)}%` : "";
			const source = item._sourceType ?? "memory";
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
		lines.push("</openviking-context>");
		return lines.join("\n");
	}

	async resolveItemContent(item: OpenVikingSearchItem): Promise<string> {
		let content = "";
		const summary = (item.abstract || item.overview || "").trim();
		if (this.config.recallPreferAbstract && summary) {
			content = summary;
		} else if (item.level === 2 || item.uri.endsWith(".md")) {
			content = (await this.client.readContent(item.uri))?.trim() || summary || memoryUriFromOpenVikingUri(item.uri);
		} else {
			content = summary || memoryUriFromOpenVikingUri(item.uri);
		}
		if (content.length > this.config.recallMaxContentChars) {
			return `${content.slice(0, this.config.recallMaxContentChars)}...`;
		}
		return content;
	}
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
