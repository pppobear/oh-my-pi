import type { OpenVikingConfig } from "./config";

export interface OpenVikingSearchSource {
	type: "memory" | "skill";
	uri: string;
	bucket: "memories" | "skills";
}

export interface OpenVikingSearchItem {
	uri: string;
	score?: number;
	abstract?: string;
	overview?: string;
	category?: string;
	level?: number;
	_sourceType?: "memory" | "skill";
	[key: string]: unknown;
}

export interface OpenVikingFetchResult<T> {
	ok: boolean;
	status?: number;
	result?: T;
	error?: string;
}

export interface OpenVikingMessagePart {
	type: "text";
	text: string;
}

export interface OpenVikingMessagePayload {
	role: string;
	content?: string;
	parts?: OpenVikingMessagePart[];
	peer_id?: string;
}

const SEARCH_SOURCES: readonly OpenVikingSearchSource[] = [
	{ type: "memory", uri: "viking://user/memories", bucket: "memories" },
	{ type: "skill", uri: "viking://user/skills", bucket: "skills" },
];

export class OpenVikingApi {
	readonly #config: OpenVikingConfig;

	constructor(config: OpenVikingConfig) {
		this.#config = config;
	}

	get baseUrl(): string {
		return this.#config.baseUrl;
	}

	async health(): Promise<OpenVikingFetchResult<unknown>> {
		return await this.#request("/health", {}, { parseJson: false });
	}

	async ready(): Promise<OpenVikingFetchResult<unknown>> {
		return await this.#request("/ready", {}, { parseJson: false });
	}

	async getSession(sessionId: string, autoCreate: boolean): Promise<OpenVikingFetchResult<unknown>> {
		const autoCreateParam = autoCreate ? "true" : "false";
		return await this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}?auto_create=${autoCreateParam}`);
	}

	async ensureSession(sessionId: string): Promise<OpenVikingFetchResult<unknown>> {
		return await this.getSession(sessionId, true);
	}

	async search(query: string, limit: number = this.#config.recallLimit): Promise<OpenVikingSearchItem[]> {
		const results = await Promise.all(SEARCH_SOURCES.map(source => this.#searchOneSource(query, source, limit)));
		return dedupeAndRank(results.flat(), query).slice(0, limit);
	}

	async readContent(uri: string): Promise<string | null> {
		const response = await this.#request<string>(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
		return response.ok && typeof response.result === "string" ? response.result : null;
	}

	async addMessage(sessionId: string, payload: OpenVikingMessagePayload): Promise<OpenVikingFetchResult<unknown>> {
		const body = this.#config.peerId && !payload.peer_id ? { ...payload, peer_id: this.#config.peerId } : payload;
		return await this.#request(
			`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
			{
				method: "POST",
				body: JSON.stringify(body),
			},
			{ timeoutMs: this.#config.captureTimeoutMs },
		);
	}

	async commitSession(sessionId: string): Promise<OpenVikingFetchResult<unknown>> {
		return await this.#request(
			`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
			{
				method: "POST",
				body: JSON.stringify({}),
			},
			{ timeoutMs: this.#config.captureTimeoutMs },
		);
	}

	async getSessionContext(sessionId: string, tokenBudget: number): Promise<string | null> {
		const response = await this.#request<unknown>(
			`/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${Math.max(1, Math.floor(tokenBudget))}`,
		);
		if (!response.ok) return null;
		if (typeof response.result === "string") return response.result;
		if (response.result && typeof response.result === "object") {
			const record = response.result as Record<string, unknown>;
			for (const key of ["context", "content", "text", "latest_archive_overview"]) {
				const value = record[key];
				if (typeof value === "string" && value.trim()) return value;
			}
		}
		return null;
	}

	async #searchOneSource(
		query: string,
		source: OpenVikingSearchSource,
		limit: number,
	): Promise<OpenVikingSearchItem[]> {
		const body = {
			query,
			target_uri: source.uri,
			limit,
			score_threshold: 0,
		};
		const response = await this.#request<Record<string, unknown>>("/api/v1/search/find", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!response.ok || !response.result || typeof response.result !== "object") return [];
		const bucket = response.result[source.bucket];
		if (!Array.isArray(bucket)) return [];
		return bucket
			.filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
			.map(item => ({ ...item, uri: typeof item.uri === "string" ? item.uri : "", _sourceType: source.type }))
			.filter(item => item.uri.length > 0);
	}

	async #request<T>(
		path: string,
		init: RequestInit = {},
		options: { parseJson?: boolean; timeoutMs?: number } = {},
	): Promise<OpenVikingFetchResult<T>> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#config.timeoutMs);
		try {
			const headers = new Headers(init.headers);
			headers.set("Content-Type", "application/json");
			if (this.#config.apiKey) headers.set("Authorization", `Bearer ${this.#config.apiKey}`);
			if (this.#config.accountId) headers.set("X-OpenViking-Account", this.#config.accountId);
			if (this.#config.userId) headers.set("X-OpenViking-User", this.#config.userId);
			if (this.#config.peerId) headers.set("X-OpenViking-Actor-Peer", this.#config.peerId);
			const response = await fetch(`${this.#config.baseUrl}${path}`, {
				...init,
				headers,
				signal: controller.signal,
			});
			if (options.parseJson === false) {
				return { ok: response.ok, status: response.status };
			}
			const body = (await response.json().catch(() => ({}))) as { status?: unknown; result?: T; error?: unknown };
			if (!response.ok || body.status === "error") {
				return { ok: false, status: response.status, error: formatOpenVikingError(body.error, response.status) };
			}
			return { ok: true, status: response.status, result: body.result ?? (body as T) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
}

function formatOpenVikingError(error: unknown, status: number): string {
	if (error && typeof error === "object") {
		const record = error as Record<string, unknown>;
		if (typeof record.message === "string") return record.message;
		if (typeof record.code === "string") return record.code;
	}
	return `HTTP ${status}`;
}

function dedupeAndRank(items: OpenVikingSearchItem[], query: string): OpenVikingSearchItem[] {
	const profile = buildQueryProfile(query);
	const seen = new Set<string>();
	const deduped: OpenVikingSearchItem[] = [];
	for (const item of items) {
		const key = isEventOrCaseItem(item)
			? `uri:${item.uri}`
			: (item.abstract || item.overview || "").trim().toLowerCase() || `uri:${item.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	deduped.sort((a, b) => rankItem(b, profile) - rankItem(a, profile));
	return deduped;
}

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i;
const TEMPORAL_QUERY_RE =
	/when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天/i;
const QUERY_TOKEN_RE = /[a-z0-9一-龥]{2,}/gi;
const STOPWORDS = new Set([
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"whose",
	"why",
	"how",
	"did",
	"does",
	"is",
	"are",
	"was",
	"were",
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"your",
	"you",
]);

interface QueryProfile {
	tokens: string[];
	wantsPreference: boolean;
	wantsTemporal: boolean;
}

function buildQueryProfile(query: string): QueryProfile {
	const text = query.trim();
	const allTokens = text.toLowerCase().match(QUERY_TOKEN_RE) ?? [];
	return {
		tokens: allTokens.filter(token => !STOPWORDS.has(token)),
		wantsPreference: PREFERENCE_QUERY_RE.test(text),
		wantsTemporal: TEMPORAL_QUERY_RE.test(text),
	};
}

function rankItem(item: OpenVikingSearchItem, profile: QueryProfile): number {
	const base =
		typeof item.score === "number" && Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : 0;
	const abstract = (item.abstract || item.overview || "").trim();
	const category = (item.category || "").toLowerCase();
	const uri = item.uri.toLowerCase();
	const leafBoost = item.level === 2 || uri.endsWith(".md") ? 0.12 : 0;
	const eventBoost = profile.wantsTemporal && (category === "events" || uri.includes("/events/")) ? 0.1 : 0;
	const preferenceBoost =
		profile.wantsPreference && (category === "preferences" || uri.includes("/preferences/")) ? 0.08 : 0;
	return (
		base + leafBoost + eventBoost + preferenceBoost + lexicalOverlapBoost(profile.tokens, `${item.uri} ${abstract}`)
	);
}

function lexicalOverlapBoost(tokens: readonly string[], text: string): number {
	if (tokens.length === 0 || !text) return 0;
	const haystack = ` ${text.toLowerCase()} `;
	let matched = 0;
	for (const token of tokens.slice(0, 8)) {
		if (haystack.includes(token)) matched += 1;
	}
	return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function isEventOrCaseItem(item: OpenVikingSearchItem): boolean {
	const category = (item.category || "").toLowerCase();
	const uri = item.uri.toLowerCase();
	return category === "events" || category === "cases" || uri.includes("/events/") || uri.includes("/cases/");
}
