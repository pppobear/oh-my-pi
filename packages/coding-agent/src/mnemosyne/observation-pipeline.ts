import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Mnemosyne } from "@oh-my-pi/pi-mnemosyne";
import type { SessionEntry, SessionMessageEntry } from "../session/session-manager";
import { readObservationMetadata } from "./observations";
import type { ObservationChunk } from "./observation-worker";

export const OBSERVATION_CHECKPOINT_CUSTOM_TYPE = "mnemosyne.observer.checkpoint";

const DEFAULT_MAX_CHUNK_CHARS = 12_000;
const BLOCK_OVERHEAD = 2;

/** Checkpoint persisted in session custom entries after a successful observer run. */
export interface ObservationCheckpoint {
	lastSourceEntryId: string;
	observedCount: number;
	writtenCount: number;
	timestamp: string;
	workerModel: string;
}

/** One parsed observation row used by diagnostics and worker context. */
export interface ObservationMemorySummary {
	id: string;
	content: string;
	timestamp: string;
	relevance: string;
	bank: string;
	sourceEntryIds: readonly string[];
}

/** Observation row counts rendered by `/memory diagnose`. */
export interface ObservationDiagnostics {
	bank: string;
	total: number;
	low: number;
	medium: number;
	high: number;
	critical: number;
}

/** Build source-labelled chunks from new branch entries after the last checkpoint. */
export function buildObservationChunks(
	entries: readonly SessionEntry[],
	options: { afterEntryId?: string; maxChunkChars?: number; maxChunks?: number } = {},
): ObservationChunk[] {
	const maxChunkChars = Math.max(1_000, Math.floor(options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS));
	const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? Number.POSITIVE_INFINITY));
	const startIndex = options.afterEntryId ? entries.findIndex(entry => entry.id === options.afterEntryId) + 1 : 0;
	const blocks = entries.slice(Math.max(0, startIndex)).flatMap(entryToSourceBlock);
	if (blocks.length === 0) return [];
	const chunks: ObservationChunk[] = [];
	let text = "";
	let sourceEntryIds: string[] = [];
	for (const block of blocks) {
		const next = text ? `${text}\n\n${block.text}` : block.text;
		if (text && next.length > maxChunkChars) {
			chunks.push({ text, sourceEntryIds });
			if (chunks.length >= maxChunks) return chunks;
			text = truncateBlock(block.text, maxChunkChars);
			sourceEntryIds = [block.id];
			continue;
		}
		text = next.length > maxChunkChars ? truncateBlock(block.text, maxChunkChars) : next;
		if (!sourceEntryIds.includes(block.id)) sourceEntryIds.push(block.id);
	}
	if (text && chunks.length < maxChunks) chunks.push({ text, sourceEntryIds });
	return chunks;
}

/** Return the latest observer checkpoint on the active branch, if any. */
export function findObservationCheckpoint(entries: readonly SessionEntry[]): ObservationCheckpoint | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== OBSERVATION_CHECKPOINT_CUSTOM_TYPE) continue;
		const checkpoint = normalizeCheckpoint(entry.data);
		if (checkpoint) return checkpoint;
	}
	return undefined;
}

/** Summaries for existing observation rows, newest first. */
export function collectObservationSummaries(
	targets: readonly { bank: string; memory: Mnemosyne }[],
	limit: number,
): ObservationMemorySummary[] {
	const out: ObservationMemorySummary[] = [];
	for (const target of targets) {
		const rows = target.memory.db
			.prepare(
				`SELECT id, content, timestamp, metadata_json FROM working_memory WHERE metadata_json LIKE ? ORDER BY timestamp DESC LIMIT ?`,
			)
			.all("%blackhole.observation%", Math.max(1, limit)) as Record<string, unknown>[];
		for (const row of rows) {
			const metadata = readObservationMetadata(row);
			if (!metadata) continue;
			const id = typeof row.id === "string" ? row.id : "";
			const content = typeof row.content === "string" ? row.content : "";
			const timestamp = typeof row.timestamp === "string" ? row.timestamp : metadata.captured_at;
			if (!id || !content) continue;
			out.push({
				id,
				content,
				timestamp,
				relevance: metadata.relevance,
				bank: target.bank,
				sourceEntryIds: metadata.source_entry_ids,
			});
		}
	}
	out.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || left.id.localeCompare(right.id));
	return out.slice(0, Math.max(0, limit));
}

/** Compact lines shown to the observer as already-known context. */
export function formatObservationSummaryLines(summaries: readonly ObservationMemorySummary[]): string[] {
	return summaries.map(
		summary =>
			`[${summary.id}] ${summary.timestamp} [${summary.relevance}] ${summary.content} (sources: ${summary.sourceEntryIds.join(", ")})`,
	);
}

/** Count observation rows by bank and relevance for slash-command diagnostics. */
export function collectObservationDiagnostics(targets: readonly { bank: string; memory: Mnemosyne }[]): ObservationDiagnostics[] {
	return targets.map(target => {
		const counts = { bank: target.bank, total: 0, low: 0, medium: 0, high: 0, critical: 0 };
		const rows = target.memory.db
			.prepare(`SELECT metadata_json FROM working_memory WHERE metadata_json LIKE ?`)
			.all("%blackhole.observation%") as Record<string, unknown>[];
		for (const row of rows) {
			const metadata = readObservationMetadata(row);
			if (!metadata) continue;
			counts.total++;
			counts[metadata.relevance]++;
		}
		return counts;
	});
}

/** Local timestamp format expected by the observer prompt. */
export function currentObservationTime(now: Date = new Date()): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function entryToSourceBlock(entry: SessionEntry): Array<{ id: string; text: string }> {
	const content = entryContent(entry);
	if (!content) return [];
	return [
		{
			id: entry.id,
			text: `[Source entry id: ${entry.id}]\n${entryLabel(entry)} @ ${entry.timestamp}:\n${content}`,
		},
	];
}

function entryContent(entry: SessionEntry): string | undefined {
	switch (entry.type) {
		case "message":
			return messageText(entry.message);
		case "branch_summary":
			return normalizeText(entry.summary);
		case "compaction":
			// Compaction summaries collapse earlier entries; re-observing them would replace
			// source-addressed evidence with the compaction entry id after every compaction.
			return undefined;
		case "custom_message":
			return typeof entry.content === "string" ? normalizeText(entry.content) : normalizeText(textBlocks(entry.content));
		default:
			return undefined;
	}
}

function entryLabel(entry: SessionEntry): string {
	if (entry.type === "message") return messageRole(entry.message);
	if (entry.type === "branch_summary") return "Branch summary";
	if (entry.type === "compaction") return "Compaction summary";
	if (entry.type === "custom_message") return `Custom message ${entry.customType}`;
	return entry.type;
}

function messageText(message: SessionMessageEntry["message"]): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const role = messageRole(message);
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return normalizeText(content);
	if (!Array.isArray(content)) return undefined;
	if (role === "assistant") return normalizeText(textBlocks(content));
	if (role === "toolResult") return normalizeText(toolResultBlocks(content));
	return normalizeText(textBlocks(content));
}

function messageRole(message: unknown): string {
	if (!message || typeof message !== "object") return "Message";
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : "Message";
}

function textBlocks(blocks: readonly unknown[]): string {
	const out: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") out.push(candidate.text);
	}
	return out.join("\n");
}

function toolResultBlocks(blocks: readonly unknown[]): string {
	const out: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as ToolResultMessage["content"][number];
		if (candidate.type === "text") out.push(candidate.text);
	}
	return out.join("\n");
}

function normalizeText(text: string): string | undefined {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	return normalized.length > 0 ? normalized : undefined;
}

function truncateBlock(text: string, maxChars: number): string {
	return `${text.slice(0, Math.max(0, maxChars - BLOCK_OVERHEAD)).trimEnd()}…`;
}

function normalizeCheckpoint(value: unknown): ObservationCheckpoint | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Partial<ObservationCheckpoint>;
	if (typeof record.lastSourceEntryId !== "string") return undefined;
	if (typeof record.timestamp !== "string") return undefined;
	if (typeof record.workerModel !== "string") return undefined;
	return {
		lastSourceEntryId: record.lastSourceEntryId,
		observedCount: typeof record.observedCount === "number" ? record.observedCount : 0,
		writtenCount: typeof record.writtenCount === "number" ? record.writtenCount : 0,
		timestamp: record.timestamp,
		workerModel: record.workerModel,
	};
}
