import { describe, expect, test } from "bun:test";
import { getBundledModel, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	buildObservationChunks,
	findObservationCheckpoint,
	OBSERVATION_CHECKPOINT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/mnemosyne/observation-pipeline";
import {
	parseObservationWorkerResponse,
	runObservationWorker,
} from "@oh-my-pi/pi-coding-agent/mnemosyne/observation-worker";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("parseObservationWorkerResponse", () => {
	test("accepts only observations with cited source entry ids from the chunk", () => {
		const observations = parseObservationWorkerResponse(
			textMessage(
				JSON.stringify({
					observations: [
						{ content: "User prefers boring fixes.", timestamp: "2026-05-31 05:10", relevance: "high", sourceEntryIds: ["e1"] },
						{ content: "Invented source should be dropped.", timestamp: "2026-05-31 05:10", relevance: "high", sourceEntryIds: ["nope"] },
						{ content: "Bad relevance should be dropped.", timestamp: "2026-05-31 05:10", relevance: "urgent", sourceEntryIds: ["e1"] },
					],
				}),
			),
			["e1"],
			"2026-05-31 05:11",
		);
		expect(observations).toEqual([
			{ content: "User prefers boring fixes.", timestamp: "2026-05-31 05:10", relevance: "high", sourceEntryIds: ["e1"] },
		]);
	});

	test("falls back to current time when the model returns a malformed timestamp", () => {
		const observations = parseObservationWorkerResponse(
			textMessage(JSON.stringify({ observations: [{ content: "x", timestamp: "now", relevance: "low", sourceEntryIds: ["e1"] }] })),
			["e1"],
			"2026-05-31 05:11",
		);
		expect(observations[0]?.timestamp).toBe("2026-05-31 05:11");
	});
});

describe("runObservationWorker", () => {
	test("renders existing observations and chunk into the worker prompt", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("expected bundled model");
		let userPrompt = "";
		const observations = await runObservationWorker({
			model,
			apiKey: "test-key",
			chunk: { text: "[Source entry id: e1]\nUser: keep it simple", sourceEntryIds: ["e1"] },
			existingObservations: ["[old] already known"],
			currentTime: "2026-05-31 05:12",
			complete: async (_model, context) => {
				userPrompt = String(context.messages[0]?.content ?? "");
				return textMessage(JSON.stringify({ observations: [{ content: "User asked to keep it simple.", timestamp: "2026-05-31 05:12", relevance: "medium", sourceEntryIds: ["e1"] }] }));
			},
		});
		expect(userPrompt).toContain("[old] already known");
		expect(userPrompt).toContain("[Source entry id: e1]");
		expect(observations[0]?.content).toBe("User asked to keep it simple.");
	});
});

describe("buildObservationChunks", () => {
	test("skips entries covered by the latest checkpoint and chunks only source-bearing entries", () => {
		const entries: SessionEntry[] = [
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-05-31T05:00:00Z", message: { role: "user", content: "old", timestamp: 0 } },
			{ type: "custom", id: "c1", parentId: "u1", timestamp: "2026-05-31T05:01:00Z", customType: OBSERVATION_CHECKPOINT_CUSTOM_TYPE, data: { lastSourceEntryId: "u1", observedCount: 1, writtenCount: 1, timestamp: "2026-05-31 05:01", workerModel: "p/m" } },
			{ type: "message", id: "u2", parentId: "c1", timestamp: "2026-05-31T05:02:00Z", message: { role: "user", content: "new fact", timestamp: 0 } },
			{ type: "model_change", id: "m1", parentId: "u2", timestamp: "2026-05-31T05:03:00Z", model: "p/m" },
		];
		const checkpoint = findObservationCheckpoint(entries);
		const chunks = buildObservationChunks(entries, { afterEntryId: checkpoint?.lastSourceEntryId });
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.sourceEntryIds).toEqual(["u2"]);
		expect(chunks[0]?.text).toContain("new fact");
		expect(chunks[0]?.text).not.toContain("old");
	});

	test("does not treat compaction summaries after a checkpoint as fresh source evidence", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-05-31T05:00:00Z",
				message: { role: "user", content: "user prefers boring fixes", timestamp: 0 },
			},
			{
				type: "custom",
				id: "checkpoint",
				parentId: "u1",
				timestamp: "2026-05-31T05:01:00Z",
				customType: OBSERVATION_CHECKPOINT_CUSTOM_TYPE,
				data: {
					lastSourceEntryId: "u1",
					observedCount: 1,
					writtenCount: 1,
					timestamp: "2026-05-31 05:01",
					workerModel: "p/m",
				},
			},
			{
				type: "compaction",
				id: "compact1",
				parentId: "checkpoint",
				timestamp: "2026-05-31T05:02:00Z",
				summary: "Prior observation says user prefers boring fixes.",
				firstKeptEntryId: "checkpoint",
				tokensBefore: 42_000,
			},
			{
				type: "message",
				id: "u2",
				parentId: "compact1",
				timestamp: "2026-05-31T05:03:00Z",
				message: { role: "user", content: "new fact after compaction", timestamp: 0 },
			},
		];
		const checkpoint = findObservationCheckpoint(entries);
		const chunks = buildObservationChunks(entries, { afterEntryId: checkpoint?.lastSourceEntryId });

		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.sourceEntryIds).toEqual(["u2"]);
		expect(chunks[0]?.text).toContain("new fact after compaction");
		expect(chunks[0]?.text).not.toContain("Prior observation");
		expect(chunks[0]?.text).not.toContain("compact1");
	});
});
