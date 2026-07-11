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

export interface OpenVikingCommitAccepted {
	status: "accepted";
	session_id: string;
	archived: true;
	task_id: string;
	archive_uri: string;
	trace_id?: string;
}

export interface OpenVikingCommitSkipped {
	status: "skipped";
	session_id: string;
	archived: false;
	task_id: null;
	archive_uri: null;
	reason: string;
	trace_id?: string;
}

export type OpenVikingCommitStart = OpenVikingCommitAccepted | OpenVikingCommitSkipped;

export type OpenVikingTaskStatus = "pending" | "running" | "completed" | "failed";

export interface OpenVikingTask {
	task_id: string;
	task_type: string;
	status: OpenVikingTaskStatus;
	resource_id?: string | null;
	stage?: string | null;
	result?: Record<string, unknown> | null;
	error?: string | null;
	created_at?: number;
	updated_at?: number;
	created_at_iso?: string;
	updated_at_iso?: string;
}

export type OpenVikingTaskWaitResult =
	| { status: "completed"; task: OpenVikingTask }
	| { status: "failed"; task: OpenVikingTask; error: string }
	| { status: "timeout"; task?: OpenVikingTask }
	| { status: "unknown"; reason: "not_found" | "protocol" | "request"; error: string }
	| { status: "aborted"; task?: OpenVikingTask };

export interface OpenVikingTaskWaitOptions {
	timeoutMs: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	expectedResourceId?: string;
	expectedArchiveUri?: string;
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
		if (response.ok) {
			if (typeof response.result === "string") return response.result;
			throw new Error("OpenViking read content failed: response did not contain text");
		}
		if (response.status === 404) return null;
		throw openVikingRequestError("read content", response);
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

	async commitSession(sessionId: string): Promise<OpenVikingFetchResult<OpenVikingCommitStart>> {
		const response = await this.#request<unknown>(
			`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
			{
				method: "POST",
				body: JSON.stringify({}),
			},
			{ timeoutMs: this.#config.captureTimeoutMs },
		);
		if (!response.ok) return fetchFailure(response);
		const parsed = parseCommitStart(response.result);
		if (!parsed.ok) return { ok: false, status: response.status, error: parsed.error };
		if (parsed.value.session_id !== sessionId) {
			return {
				ok: false,
				status: response.status,
				error: `Invalid OpenViking commit response: expected session_id ${sessionId}`,
			};
		}
		return { ok: true, status: response.status, result: parsed.value };
	}

	async getTask(taskId: string): Promise<OpenVikingFetchResult<OpenVikingTask>> {
		return await this.#getTask(taskId);
	}

	async listCommitTasks(sessionId: string, limit = 200): Promise<OpenVikingFetchResult<OpenVikingTask[]>> {
		const normalizedLimit = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 200;
		const response = await this.#request<unknown>(
			`/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(sessionId)}&limit=${normalizedLimit}`,
			{ method: "GET" },
		);
		if (!response.ok) return fetchFailure(response);
		if (!Array.isArray(response.result)) {
			return {
				ok: false,
				status: response.status,
				error: "Invalid OpenViking task list response: expected an array",
			};
		}

		const tasks: OpenVikingTask[] = [];
		for (const [index, value] of response.result.entries()) {
			const parsed = parseTask(value);
			if (!parsed.ok) {
				return {
					ok: false,
					status: response.status,
					error: `Invalid OpenViking task list response at index ${index}: ${parsed.error}`,
				};
			}
			if (parsed.value.task_type !== "session_commit") {
				return {
					ok: false,
					status: response.status,
					error: `Invalid OpenViking commit task list: expected task_type session_commit at index ${index}`,
				};
			}
			if (parsed.value.resource_id !== sessionId) {
				return {
					ok: false,
					status: response.status,
					error: `Invalid OpenViking commit task list: expected resource_id ${sessionId} at index ${index}`,
				};
			}
			tasks.push(parsed.value);
		}

		return { ok: true, status: response.status, result: tasks };
	}

	async waitForCommitTask(taskId: string, options: OpenVikingTaskWaitOptions): Promise<OpenVikingTaskWaitResult> {
		const timeoutMs = normalizeNonNegativeDuration(options.timeoutMs);
		const pollIntervalMs = normalizePositiveDuration(options.pollIntervalMs, 750);
		const startedAt = performance.now();
		let lastTask: OpenVikingTask | undefined;
		let attempted = false;

		while (true) {
			if (options.signal?.aborted) return { status: "aborted", task: lastTask };
			const elapsedMs = performance.now() - startedAt;
			if (attempted && elapsedMs >= timeoutMs) return { status: "timeout", task: lastTask };

			const remainingMs = Math.max(1, timeoutMs - elapsedMs);
			const response = await this.#getTask(taskId, remainingMs, options.signal);
			attempted = true;
			if (options.signal?.aborted) return { status: "aborted", task: lastTask };
			if (!response.ok || !response.result) {
				if (performance.now() - startedAt >= timeoutMs) return { status: "timeout", task: lastTask };
				return {
					status: "unknown",
					reason: classifyUnknownTaskResponse(response),
					error: taskRequestError(response),
				};
			}

			lastTask = response.result;
			if (lastTask.task_type !== "session_commit") {
				return {
					status: "unknown",
					reason: "protocol",
					error: `Invalid OpenViking commit task: expected task_type session_commit, received ${lastTask.task_type}`,
				};
			}
			if (options.expectedResourceId && lastTask.resource_id !== options.expectedResourceId) {
				return {
					status: "unknown",
					reason: "protocol",
					error: `Invalid OpenViking commit task: expected resource_id ${options.expectedResourceId}`,
				};
			}
			if (lastTask.status === "completed" && options.expectedArchiveUri) {
				const archiveUri = lastTask.result?.archive_uri;
				if (archiveUri !== options.expectedArchiveUri) {
					return {
						status: "unknown",
						reason: "protocol",
						error: `Invalid OpenViking commit task: expected archive_uri ${options.expectedArchiveUri}`,
					};
				}
			}
			if (lastTask.status === "completed") return { status: "completed", task: lastTask };
			if (lastTask.status === "failed") {
				return { status: "failed", task: lastTask, error: lastTask.error || "OpenViking commit task failed" };
			}

			const remainingAfterRequestMs = timeoutMs - (performance.now() - startedAt);
			if (remainingAfterRequestMs <= 0) return { status: "timeout", task: lastTask };
			const sleepMs = Math.min(pollIntervalMs, remainingAfterRequestMs);
			const slept = await sleepWithSignal(sleepMs, options.signal);
			if (!slept) return { status: "aborted", task: lastTask };
			if (sleepMs >= remainingAfterRequestMs) return { status: "timeout", task: lastTask };
		}
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
		if (!response.ok) throw openVikingRequestError(`search ${source.type}`, response);
		if (!response.result || typeof response.result !== "object") {
			throw new Error(`OpenViking search ${source.type} failed: response did not contain a result object`);
		}
		const bucket = response.result[source.bucket];
		if (!Array.isArray(bucket)) return [];
		return bucket
			.filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
			.map(item => ({ ...item, uri: typeof item.uri === "string" ? item.uri : "", _sourceType: source.type }))
			.filter(item => item.uri.length > 0);
	}

	async #getTask(
		taskId: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<OpenVikingFetchResult<OpenVikingTask>> {
		const response = await this.#request<unknown>(
			`/api/v1/tasks/${encodeURIComponent(taskId)}`,
			{ signal },
			{ timeoutMs },
		);
		if (!response.ok) return fetchFailure(response);
		const parsed = parseTaskForId(response.result, taskId);
		if (!parsed.ok) return { ok: false, status: response.status, error: parsed.error };
		return { ok: true, status: response.status, result: parsed.value };
	}

	async #request<T>(
		path: string,
		init: RequestInit = {},
		options: { parseJson?: boolean; timeoutMs?: number } = {},
	): Promise<OpenVikingFetchResult<T>> {
		const controller = new AbortController();
		const externalSignal = init.signal ?? undefined;
		const relayAbort = () => controller.abort(externalSignal?.reason);
		if (externalSignal?.aborted) relayAbort();
		else externalSignal?.addEventListener("abort", relayAbort, { once: true });
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
			externalSignal?.removeEventListener("abort", relayAbort);
		}
	}
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseCommitStart(value: unknown): ParseResult<OpenVikingCommitStart> {
	if (!isRecord(value)) return { ok: false, error: "Invalid OpenViking commit response: expected an object" };
	const traceId = value.trace_id;
	if (traceId !== undefined && typeof traceId !== "string") {
		return { ok: false, error: "Invalid OpenViking commit response: trace_id must be a string" };
	}
	if (typeof value.session_id !== "string" || !value.session_id.trim()) {
		return { ok: false, error: "Invalid OpenViking commit response: session_id must be a non-empty string" };
	}

	if (value.status === "accepted") {
		if (
			value.archived !== true ||
			typeof value.task_id !== "string" ||
			!value.task_id.trim() ||
			typeof value.archive_uri !== "string" ||
			!value.archive_uri.trim()
		) {
			return {
				ok: false,
				error: "Invalid OpenViking commit response: accepted commits require archived=true, task_id, and archive_uri",
			};
		}
		return {
			ok: true,
			value: {
				status: "accepted",
				session_id: value.session_id,
				archived: true,
				task_id: value.task_id,
				archive_uri: value.archive_uri,
				...(traceId === undefined ? {} : { trace_id: traceId }),
			},
		};
	}

	if (value.status === "skipped") {
		if (
			value.archived !== false ||
			value.task_id !== null ||
			value.archive_uri !== null ||
			typeof value.reason !== "string" ||
			!value.reason.trim()
		) {
			return {
				ok: false,
				error: "Invalid OpenViking commit response: skipped commits require archived=false, null task_id/archive_uri, and a reason",
			};
		}
		return {
			ok: true,
			value: {
				status: "skipped",
				session_id: value.session_id,
				archived: false,
				task_id: null,
				archive_uri: null,
				reason: value.reason,
				...(traceId === undefined ? {} : { trace_id: traceId }),
			},
		};
	}

	return { ok: false, error: "Invalid OpenViking commit response: status must be accepted or skipped" };
}

function parseTaskForId(value: unknown, expectedTaskId: string): ParseResult<OpenVikingTask> {
	const parsed = parseTask(value);
	if (!parsed.ok) return parsed;
	if (parsed.value.task_id !== expectedTaskId) {
		return { ok: false, error: `Invalid OpenViking task response: expected task_id ${expectedTaskId}` };
	}
	return parsed;
}

function parseTask(value: unknown): ParseResult<OpenVikingTask> {
	if (!isRecord(value)) return { ok: false, error: "Invalid OpenViking task response: expected an object" };
	if (typeof value.task_id !== "string" || !value.task_id.trim()) {
		return { ok: false, error: "Invalid OpenViking task response: task_id must be a non-empty string" };
	}
	if (typeof value.task_type !== "string" || !value.task_type.trim()) {
		return { ok: false, error: "Invalid OpenViking task response: task_type must be a non-empty string" };
	}
	if (!isTaskStatus(value.status)) {
		return { ok: false, error: "Invalid OpenViking task response: unrecognized task status" };
	}
	const taskError = value.error;
	if (taskError !== undefined && taskError !== null && typeof taskError !== "string") {
		return { ok: false, error: "Invalid OpenViking task response: error must be a string or null" };
	}
	const taskResult = value.result;
	if (taskResult !== undefined && taskResult !== null && !isRecord(taskResult)) {
		return { ok: false, error: "Invalid OpenViking task response: result must be an object or null" };
	}

	return {
		ok: true,
		value: {
			task_id: value.task_id,
			task_type: value.task_type,
			status: value.status,
			...(isNullableString(value.resource_id) ? { resource_id: value.resource_id } : {}),
			...(isNullableString(value.stage) ? { stage: value.stage } : {}),
			...(taskResult === undefined ? {} : { result: taskResult }),
			...(taskError === undefined ? {} : { error: taskError }),
			...(typeof value.created_at === "number" ? { created_at: value.created_at } : {}),
			...(typeof value.updated_at === "number" ? { updated_at: value.updated_at } : {}),
			...(typeof value.created_at_iso === "string" ? { created_at_iso: value.created_at_iso } : {}),
			...(typeof value.updated_at_iso === "string" ? { updated_at_iso: value.updated_at_iso } : {}),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is OpenVikingTaskStatus {
	return value === "pending" || value === "running" || value === "completed" || value === "failed";
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function normalizeNonNegativeDuration(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizePositiveDuration(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (!signal) {
		await Bun.sleep(ms);
		return true;
	}
	if (signal.aborted) return false;
	const aborted = Promise.withResolvers<false>();
	const onAbort = () => aborted.resolve(false);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([Bun.sleep(ms).then(() => true as const), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function taskRequestError(response: OpenVikingFetchResult<unknown>): string {
	return (
		response.error ?? (response.status === undefined ? "OpenViking task request failed" : `HTTP ${response.status}`)
	);
}

function classifyUnknownTaskResponse(response: OpenVikingFetchResult<unknown>): "not_found" | "protocol" | "request" {
	if (response.status === 404) return "not_found";
	if (response.status !== undefined && response.status >= 200 && response.status < 300) return "protocol";
	return "request";
}

function fetchFailure<T>(response: OpenVikingFetchResult<unknown>): OpenVikingFetchResult<T> {
	return {
		ok: false,
		...(response.status === undefined ? {} : { status: response.status }),
		...(response.error === undefined ? {} : { error: response.error }),
	};
}

function openVikingRequestError(operation: string, response: OpenVikingFetchResult<unknown>): Error {
	const detail = response.error ?? (response.status === undefined ? "request failed" : `HTTP ${response.status}`);
	return new Error(`OpenViking ${operation} failed: ${detail}`);
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
