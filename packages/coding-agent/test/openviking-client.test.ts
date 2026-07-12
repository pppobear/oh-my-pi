import { afterEach, describe, expect, it, vi } from "bun:test";
import { OpenVikingApi } from "@oh-my-pi/pi-coding-agent/openviking/client";
import type { OpenVikingConfig } from "@oh-my-pi/pi-coding-agent/openviking/config";

const config: OpenVikingConfig = {
	baseUrl: "http://openviking.test",
	apiKey: null,
	accountId: null,
	userId: null,
	peerId: null,
	peerSource: "none",
	workspacePeer: false,
	recallPeerScope: "actor",
	timeoutMs: 1_000,
	captureTimeoutMs: 1_000,
	autoRecall: true,
	autoRetain: true,
	recallLimit: 4,
	scoreThreshold: 0.35,
	minQueryLength: 3,
	recallMaxContentChars: 500,
	recallTokenBudget: 2_000,
	recallPreferAbstract: true,
	recallContextTurns: 3,
	captureAssistantTurns: true,
	commitEveryNTurns: 2,
	debug: false,
};

function fetchUntilAborted(_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
	const pending = Promise.withResolvers<Response>();
	const signal = init?.signal;
	const rejectAborted = () => pending.reject(new DOMException("Aborted", "AbortError"));
	if (signal?.aborted) rejectAborted();
	else signal?.addEventListener("abort", rejectAborted, { once: true });
	return pending.promise;
}

describe("OpenViking API error mapping", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces authentication failures instead of reporting an empty search", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			Response.json(
				{ status: "error", error: { code: "UNAUTHORIZED", message: "invalid OpenViking credentials" } },
				{ status: 401 },
			)) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		await expect(client.search("deployment preferences")).rejects.toThrow("invalid OpenViking credentials");
	});

	it("returns missing content only for 404 responses", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({ status: "error", error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 }),
			)
			.mockResolvedValueOnce(
				Response.json(
					{ status: "error", error: { code: "UNAVAILABLE", message: "OpenViking unavailable" } },
					{ status: 503 },
				),
			);
		const client = new OpenVikingApi(config);

		await expect(client.readContent("viking://user/memories/missing.md")).resolves.toBeNull();
		await expect(client.readContent("viking://user/memories/preferences.md")).rejects.toThrow(
			"OpenViking unavailable",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("surfaces malformed successful responses instead of treating them as missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", result: {} }));
		const client = new OpenVikingApi(config);

		await expect(client.readContent("viking://user/memories/preferences.md")).rejects.toThrow(
			"response did not contain text",
		);
	});
});

describe("OpenViking peer-aware recall", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recalls current-peer memories through the v0.4.9 recall endpoint", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown>; actorPeer: string | null }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body, actorPeer: new Headers(init?.headers).get("X-OpenViking-Actor-Peer") });
			if (url.endsWith("/api/v1/search/recall")) {
				return Response.json({
					status: "ok",
					result: {
						entries: [
							{
								uri: "viking://user/test/peers/project-a/memories/preferences/editor.md",
								score: 0.91,
								type: "preferences",
								mode: "full",
								content: "Prefers concise reviews.",
								origin: "actor_peer",
							},
						],
						rendered: "",
						stats: {},
					},
				});
			}
			return Response.json({ status: "ok", result: { skills: [] } });
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({
			...config,
			peerId: "project-a",
			peerSource: "workspace",
			workspacePeer: true,
		});

		const result = await client.search("editor preference");

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			category: "preferences",
			content: "Prefers concise reviews.",
			origin: "actor_peer",
			_sourceType: "memory",
		});
		const recallRequest = requests.find(request => request.url.endsWith("/api/v1/search/recall"));
		expect(recallRequest).toMatchObject({
			actorPeer: "project-a",
			body: {
				peer_scope: "actor",
				min_score: 0.35,
				render: false,
			},
		});
	});

	it("retries v0.4.8 recall without peer_scope and keeps current-peer memories", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		let recallRequests = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.endsWith("/api/v1/search/recall")) {
				recallRequests++;
				if (recallRequests === 1) {
					return Response.json(
						{ status: "error", error: { code: "INVALID_ARGUMENT", message: "peer_scope unsupported" } },
						{ status: 422 },
					);
				}
				return Response.json({
					status: "ok",
					result: {
						entries: [
							{
								uri: "viking://user/test/peers/project-a/memories/preferences/editor.md",
								score: 0.88,
								type: "preferences",
								mode: "full",
								content: "Uses the project editor settings.",
								rank: 1,
							},
						],
						rendered: "",
						stats: {},
					},
				});
			}
			return Response.json({ status: "ok", result: { skills: [] } });
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({ ...config, peerId: "project-a", peerSource: "workspace" });

		await expect(client.search("editor preference")).resolves.toMatchObject([
			{
				uri: "viking://user/test/peers/project-a/memories/preferences/editor.md",
				_sourceType: "memory",
			},
		]);
		expect(recallRequests).toBe(2);
		const recallBodies = requests
			.filter(request => request.url.endsWith("/api/v1/search/recall"))
			.map(request => request.body);
		expect(recallBodies[0]?.peer_scope).toBe("actor");
		expect(recallBodies[1]).not.toHaveProperty("peer_scope");
		expect(requests.some(request => request.body.target_uri === "viking://user/memories")).toBe(false);
	});

	it("uses legacy find only when the recall endpoint is absent", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.endsWith("/api/v1/search/recall")) {
				return Response.json(
					{ status: "error", error: { code: "NOT_FOUND", message: "not found" } },
					{ status: 404 },
				);
			}
			if (body.target_uri === "viking://user/memories") {
				return Response.json({
					status: "ok",
					result: { memories: [{ uri: "viking://user/memories/preferences/global.md", score: 0.8 }] },
				});
			}
			return Response.json({ status: "ok", result: { skills: [] } });
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({ ...config, peerId: "project-a", peerSource: "workspace" });

		await expect(client.search("global preference")).resolves.toMatchObject([
			{ uri: "viking://user/memories/preferences/global.md", _sourceType: "memory" },
		]);
		expect(requests.filter(request => request.url.endsWith("/api/v1/search/recall"))).toHaveLength(1);
		expect(requests.some(request => request.body.target_uri === "viking://user/memories")).toBe(true);
	});

	it("surfaces a validation failure after the peer_scope downgrade", async () => {
		let recallRequests = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			recallRequests++;
			return Response.json(
				{
					status: "error",
					error: {
						code: "INVALID_ARGUMENT",
						message: recallRequests === 1 ? "peer_scope unsupported" : "invalid recall quotas",
					},
				},
				{ status: recallRequests === 1 ? 422 : 400 },
			);
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({ ...config, peerId: "project-a", peerSource: "workspace" });

		await expect(client.search("editor preference")).rejects.toThrow("invalid recall quotas");
		expect(recallRequests).toBe(2);
	});

	it("rejects malformed recall text fields before rendering them", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			return Response.json({
				status: "ok",
				result: {
					entries: [
						{
							uri: "viking://user/memories/entities/service.md",
							type: "entities",
							content: 42,
						},
					],
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		await expect(client.search("service owner")).rejects.toThrow("entry 0 has an invalid content");
	});

	it("preserves server order across memory types and per-type peer ranks", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			return Response.json({
				status: "ok",
				result: {
					entries: [
						{
							uri: "viking://user/test/peers/project-b/memories/events/deploy.md",
							score: 0.9,
							type: "events",
							mode: "summary",
							origin: "other_peer",
							rank: 1,
						},
						{
							uri: "viking://user/test/peers/project-a/memories/entities/current.md",
							score: 0.86,
							type: "entities",
							mode: "summary",
							origin: "actor_peer",
							rank: 1,
						},
						{
							uri: "viking://user/test/peers/project-b/memories/entities/other.md",
							score: 0.95,
							type: "entities",
							mode: "summary",
							origin: "other_peer",
							rank: 2,
						},
					],
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi({ ...config, recallPeerScope: "all" });

		const result = await client.search("service ownership", 3);

		expect(result.map(item => ({ category: item.category, origin: item.origin, rank: item.rank }))).toEqual([
			{ category: "events", origin: "other_peer", rank: 1 },
			{ category: "entities", origin: "actor_peer", rank: 1 },
			{ category: "entities", origin: "other_peer", rank: 2 },
		]);
	});

	it("requests upstream per-type quotas while reserving total-result coverage", async () => {
		let recallBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			recallBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				status: "ok",
				result: {
					entries: [
						{ uri: "viking://user/memories/events/deploy.md", score: 0.9, type: "events", rank: 1 },
						{ uri: "viking://user/memories/entities/service.md", score: 0.8, type: "entities", rank: 1 },
						{
							uri: "viking://user/memories/preferences/editor.md",
							score: 0.7,
							type: "preferences",
							rank: 1,
						},
					],
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		const result = await client.search("deployment editor ownership", 5);

		expect(recallBody?.quotas).toEqual({ events: 5, entities: 5, preferences: 3, experiences: 0 });
		expect(result.map(item => item.category)).toEqual(["events", "entities", "preferences"]);
	});

	it("donates empty type reservations so a sparse bucket can fill the total limit", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			return Response.json({
				status: "ok",
				result: {
					entries: Array.from({ length: 6 }, (_value, index) => ({
						uri: `viking://user/memories/entities/service-${index + 1}.md`,
						score: 0.9 - index * 0.01,
						type: "entities",
						rank: index + 1,
					})),
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		const result = await client.search("service ownership", 5);

		expect(result).toHaveLength(5);
		expect(result.every(item => item.category === "entities")).toBe(true);
	});

	it("reserves small recall limits for explicit preference queries", async () => {
		const recallBodies: Record<string, unknown>[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			recallBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({
				status: "ok",
				result: {
					entries: [
						{
							uri: "viking://user/memories/events/editor-release.md",
							score: 0.95,
							type: "events",
							rank: 1,
						},
						{
							uri: "viking://user/memories/preferences/editor.md",
							score: 0.9,
							type: "preferences",
							rank: 1,
						},
					],
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		await expect(client.search("editor preference", 1)).resolves.toEqual([
			expect.objectContaining({ category: "preferences" }),
		]);
		await expect(client.search("favorite editor", 2)).resolves.toEqual([
			expect.objectContaining({ category: "events" }),
			expect.objectContaining({ category: "preferences" }),
		]);
		await expect(client.search("likely deployment failure", 1)).resolves.toEqual([
			expect.objectContaining({ category: "events" }),
		]);
		expect(recallBodies.map(body => body.quotas)).toEqual([
			{ events: 1, entities: 1, preferences: 1, experiences: 0 },
			{ events: 2, entities: 2, preferences: 2, experiences: 0 },
			{ events: 1, entities: 1, preferences: 1, experiences: 0 },
		]);
	});

	it("keeps distinct server recall entries that share an abstract", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
			if (!String(input).endsWith("/api/v1/search/recall")) {
				return Response.json({ status: "ok", result: { skills: [] } });
			}
			return Response.json({
				status: "ok",
				result: {
					entries: [
						{
							uri: "viking://user/memories/entities/service-a.md",
							score: 0.9,
							type: "entities",
							abstract: "Service owner",
							content: "Service A belongs to team A.",
							rank: 1,
						},
						{
							uri: "viking://user/memories/entities/service-b.md",
							score: 0.8,
							type: "entities",
							abstract: "Service owner",
							content: "Service B belongs to team B.",
							rank: 2,
						},
					],
					rendered: "",
					stats: {},
				},
			});
		}) as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		const result = await client.search("service owner", 2);

		expect(result.map(item => item.uri)).toEqual([
			"viking://user/memories/entities/service-a.md",
			"viking://user/memories/entities/service-b.md",
		]);
	});
});

describe("OpenViking commit task API", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses accepted and skipped commit responses", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: {
						status: "accepted",
						session_id: "session-1",
						archived: true,
						task_id: "task-1",
						archive_uri: "viking://session/session-1/history/archive_001",
						trace_id: "trace-1",
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: {
						status: "skipped",
						session_id: "session-1",
						archived: false,
						task_id: null,
						archive_uri: null,
						reason: "no_messages",
					},
				}),
			);
		const client = new OpenVikingApi(config);

		await expect(client.commitSession("session-1")).resolves.toEqual({
			ok: true,
			status: 200,
			result: {
				status: "accepted",
				session_id: "session-1",
				archived: true,
				task_id: "task-1",
				archive_uri: "viking://session/session-1/history/archive_001",
				trace_id: "trace-1",
			},
		});
		await expect(client.commitSession("session-1")).resolves.toEqual({
			ok: true,
			status: 200,
			result: {
				status: "skipped",
				session_id: "session-1",
				archived: false,
				task_id: null,
				archive_uri: null,
				reason: "no_messages",
			},
		});
		expect(fetchSpy).toHaveBeenNthCalledWith(
			1,
			"http://openviking.test/api/v1/sessions/session-1/commit",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("rejects accepted commits without their Phase 2 task metadata", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					status: "accepted",
					session_id: "session-1",
					archived: true,
					task_id: "task-1",
				},
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(client.commitSession("session-1")).resolves.toEqual({
			ok: false,
			status: 200,
			error: "Invalid OpenViking commit response: accepted commits require archived=true, task_id, and archive_uri",
		});
	});

	it("rejects commit metadata for a different session", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					status: "accepted",
					session_id: "different-session",
					archived: true,
					task_id: "task-1",
					archive_uri: "viking://session/different-session/history/archive_001",
				},
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(client.commitSession("session-1")).resolves.toEqual({
			ok: false,
			status: 200,
			error: "Invalid OpenViking commit response: expected session_id session-1",
		});
	});

	it("gets and validates a task snapshot", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					task_id: "task/1",
					task_type: "session_commit",
					status: "running",
					resource_id: "session-1",
					stage: "extracting_memories",
					result: null,
					error: null,
				},
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(client.getTask("task/1")).resolves.toEqual({
			ok: true,
			status: 200,
			result: {
				task_id: "task/1",
				task_type: "session_commit",
				status: "running",
				resource_id: "session-1",
				stage: "extracting_memories",
				result: null,
				error: null,
			},
		});
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://openviking.test/api/v1/tasks/task%2F1");
	});

	it("lists commit tasks in newest-first server order with encoded filters", async () => {
		const sessionId = "session/with space?&";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: [
					{
						task_id: "task-newest",
						task_type: "session_commit",
						status: "completed",
						resource_id: sessionId,
						created_at: 20,
					},
					{
						task_id: "task-older",
						task_type: "session_commit",
						status: "failed",
						resource_id: sessionId,
						created_at: 10,
						error: "commit failed",
					},
				],
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(client.listCommitTasks(sessionId, 7)).resolves.toEqual({
			ok: true,
			status: 200,
			result: [
				{
					task_id: "task-newest",
					task_type: "session_commit",
					status: "completed",
					resource_id: sessionId,
					created_at: 20,
				},
				{
					task_id: "task-older",
					task_type: "session_commit",
					status: "failed",
					resource_id: sessionId,
					created_at: 10,
					error: "commit failed",
				},
			],
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"http://openviking.test/api/v1/tasks?task_type=session_commit&resource_id=session%2Fwith%20space%3F%26&limit=7",
		);
		expect(fetchSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "GET" }));
	});

	it("rejects a task-list response whose result is not an array", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", result: { tasks: [] } }));
		const client = new OpenVikingApi(config);

		await expect(client.listCommitTasks("session-1")).resolves.toEqual({
			ok: false,
			status: 200,
			error: "Invalid OpenViking task list response: expected an array",
		});
	});

	it("clamps the commit task-list limit to the server maximum", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ok", result: [] }));
		const client = new OpenVikingApi(config);

		await expect(client.listCommitTasks("session-1", 10_000)).resolves.toMatchObject({ ok: true, result: [] });
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(
			"http://openviking.test/api/v1/tasks?task_type=session_commit&resource_id=session-1&limit=200",
		);
	});

	it("rejects a malformed task inside a task-list array", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: [{ task_id: "task-1", task_type: "session_commit", status: "unknown", resource_id: "session-1" }],
			}),
		);
		const client = new OpenVikingApi(config);

		const response = await client.listCommitTasks("session-1");
		expect(response.ok).toBe(false);
		expect(response.error).toContain("at index 0");
		expect(response.error).toContain("unrecognized task status");
	});

	it("rejects task-list entries for the wrong type or resource", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: [
						{
							task_id: "task-1",
							task_type: "resource_reindex",
							status: "completed",
							resource_id: "session-1",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: [
						{
							task_id: "task-2",
							task_type: "session_commit",
							status: "completed",
							resource_id: "different-session",
						},
					],
				}),
			);
		const client = new OpenVikingApi(config);

		await expect(client.listCommitTasks("session-1")).resolves.toEqual({
			ok: false,
			status: 200,
			error: "Invalid OpenViking commit task list: expected task_type session_commit at index 0",
		});
		await expect(client.listCommitTasks("session-1")).resolves.toEqual({
			ok: false,
			status: 200,
			error: "Invalid OpenViking commit task list: expected resource_id session-1 at index 0",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("waits through pending and running snapshots until completion", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: { task_id: "task-1", task_type: "session_commit", status: "pending" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: { task_id: "task-1", task_type: "session_commit", status: "running" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "ok",
					result: {
						task_id: "task-1",
						task_type: "session_commit",
						status: "completed",
						result: { memories_extracted: { preferences: 1 } },
					},
				}),
			);
		const client = new OpenVikingApi(config);

		const result = await client.waitForCommitTask("task-1", { timeoutMs: 200, pollIntervalMs: 1 });

		expect(result).toEqual({
			status: "completed",
			task: {
				task_id: "task-1",
				task_type: "session_commit",
				status: "completed",
				result: { memories_extracted: { preferences: 1 } },
			},
		});
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("returns the server's failure and task snapshot", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					task_id: "task-1",
					task_type: "session_commit",
					status: "failed",
					error: "memory extraction failed",
				},
			}),
		);
		const client = new OpenVikingApi(config);

		const result = await client.waitForCommitTask("task-1", { timeoutMs: 100 });

		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("Expected failed task result");
		expect(result.error).toBe("memory extraction failed");
		expect(result.task.status).toBe("failed");
	});

	it("returns the last observed task when polling times out", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: { task_id: "task-1", task_type: "session_commit", status: "running" },
			}),
		);
		const client = new OpenVikingApi(config);

		const result = await client.waitForCommitTask("task-1", { timeoutMs: 2, pollIntervalMs: 20 });

		expect(result).toEqual({
			status: "timeout",
			task: { task_id: "task-1", task_type: "session_commit", status: "running" },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("distinguishes an unknown task from a failed task", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json(
				{ status: "error", error: { code: "NOT_FOUND", message: "Task not found or expired" } },
				{ status: 404 },
			),
		);
		const client = new OpenVikingApi(config);

		await expect(client.waitForCommitTask("missing", { timeoutMs: 100 })).resolves.toEqual({
			status: "unknown",
			reason: "not_found",
			error: "Task not found or expired",
		});
	});

	it("does not treat a different task type as commit completion", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: { task_id: "task-1", task_type: "resource_reindex", status: "completed" },
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(client.waitForCommitTask("task-1", { timeoutMs: 100 })).resolves.toEqual({
			status: "unknown",
			reason: "protocol",
			error: "Invalid OpenViking commit task: expected task_type session_commit, received resource_reindex",
		});
	});

	it("validates the commit task resource identity", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					task_id: "task-1",
					task_type: "session_commit",
					status: "completed",
					resource_id: "different-session",
					result: { archive_uri: "viking://session/session-1/history/archive_001" },
				},
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(
			client.waitForCommitTask("task-1", { timeoutMs: 100, expectedResourceId: "session-1" }),
		).resolves.toEqual({
			status: "unknown",
			reason: "protocol",
			error: "Invalid OpenViking commit task: expected resource_id session-1",
		});
	});

	it("validates the completed task archive identity", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: {
					task_id: "task-1",
					task_type: "session_commit",
					status: "completed",
					resource_id: "session-1",
					result: { archive_uri: "viking://session/session-1/history/archive_999" },
				},
			}),
		);
		const client = new OpenVikingApi(config);

		await expect(
			client.waitForCommitTask("task-1", {
				timeoutMs: 100,
				expectedResourceId: "session-1",
				expectedArchiveUri: "viking://session/session-1/history/archive_001",
			}),
		).resolves.toEqual({
			status: "unknown",
			reason: "protocol",
			error: "Invalid OpenViking commit task: expected archive_uri viking://session/session-1/history/archive_001",
		});
	});

	it("stops without polling when already aborted", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		const client = new OpenVikingApi(config);

		await expect(
			client.waitForCommitTask("task-1", { timeoutMs: 100, pollIntervalMs: 1, signal: controller.signal }),
		).resolves.toEqual({ status: "aborted", task: undefined });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns the last task when aborted between polls", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				status: "ok",
				result: { task_id: "task-1", task_type: "session_commit", status: "pending" },
			}),
		);
		const controller = new AbortController();
		const client = new OpenVikingApi(config);
		const waiting = client.waitForCommitTask("task-1", {
			timeoutMs: 500,
			pollIntervalMs: 100,
			signal: controller.signal,
		});

		await Bun.sleep(1);
		controller.abort();

		await expect(waiting).resolves.toEqual({
			status: "aborted",
			task: { task_id: "task-1", task_type: "session_commit", status: "pending" },
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("bounds an in-flight task request by the total wait deadline", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchUntilAborted as unknown as typeof fetch);
		const client = new OpenVikingApi(config);

		await expect(client.waitForCommitTask("task-1", { timeoutMs: 5 })).resolves.toEqual({
			status: "timeout",
			task: undefined,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("relays external abort into an in-flight task request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchUntilAborted as unknown as typeof fetch);
		const controller = new AbortController();
		const client = new OpenVikingApi(config);
		const waiting = client.waitForCommitTask("task-1", { timeoutMs: 500, signal: controller.signal });

		await Bun.sleep(1);
		controller.abort();

		await expect(waiting).resolves.toEqual({ status: "aborted", task: undefined });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
