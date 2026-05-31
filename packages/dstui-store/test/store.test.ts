import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DstuiStore, StoreEncodingError, StoreNameError, StoreQuotaError } from "../src/store";

async function makeTempRoot(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "dstui-store-"));
}

const VALID_SOURCE = `
	(defcomponent picker (selected-index)
		(state (idx (if selected-index selected-index 0)))
		(view (text (str idx)))
		(bind :enter (emit idx)))
`;

describe("DstuiStore", () => {
	let root: string;
	let store: DstuiStore;

	beforeEach(async () => {
		root = await makeTempRoot();
		store = new DstuiStore({ root });
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("saveModule + loadModule round-trips source and compiles it", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		const entry = await store.loadModule("picker");
		expect(entry).not.toBeNull();
		expect(entry?.name).toBe("picker");
		expect(entry?.source).toBe(VALID_SOURCE);
		expect(entry?.module.components.map(c => c.name)).toEqual(["picker"]);
		expect(entry?.state).toBeUndefined();
	});

	test("saveState persists JSON-encoded state alongside the source", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		await store.saveState("picker", { selectedIndex: 3, label: "hi" });
		const entry = await store.loadModule("picker");
		expect(entry?.state).toEqual({ selectedIndex: 3, label: "hi" });
	});

	test("saveState(undefined) deletes the existing state file", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		await store.saveState("picker", { x: 1 });
		await store.saveState("picker", undefined);
		const entry = await store.loadModule("picker");
		expect(entry?.state).toBeUndefined();
	});

	test("loadModule returns null when the entry does not exist", async () => {
		expect(await store.loadModule("missing")).toBeNull();
	});

	test("rejects directory-traversal names", async () => {
		for (const bad of ["../escape", "foo/bar", "..", "", " spaces ", "name\x00", "a".repeat(65)]) {
			expect(() => store.pathFor(bad)).toThrow(StoreNameError);
			await expect(store.saveModule(bad, VALID_SOURCE)).rejects.toThrow(StoreNameError);
		}
	});

	test("rejects oversized source above maxSourceBytes", async () => {
		const small = new DstuiStore({ root, maxSourceBytes: 16 });
		await expect(small.saveModule("picker", VALID_SOURCE)).rejects.toThrow(StoreQuotaError);
		// Source file must not have been written.
		await expect(fs.stat(path.join(root, "picker", "source.dsl"))).rejects.toBeDefined();
	});

	test("rejects oversized state above maxStateBytes", async () => {
		const small = new DstuiStore({ root, maxStateBytes: 8 });
		await small.saveModule("picker", VALID_SOURCE);
		await expect(small.saveState("picker", { x: "this is bigger than eight bytes" })).rejects.toThrow(
			StoreQuotaError,
		);
		const entry = await small.loadModule("picker");
		expect(entry?.state).toBeUndefined();
	});

	test("saveState rejects unencodable values with StoreEncodingError", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		await expect(store.saveState("picker", () => null)).rejects.toThrow(StoreEncodingError);
		await expect(store.saveState("picker", Symbol("nope"))).rejects.toThrow(StoreEncodingError);
		await expect(store.saveState("picker", 1n)).rejects.toThrow(StoreEncodingError);
	});

	test("saveState accepts encodable atoms (number, string, bool, null)", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		await store.saveState("picker", 7);
		expect((await store.loadModule("picker"))?.state).toBe(7);
		await store.saveState("picker", null);
		expect((await store.loadModule("picker"))?.state).toBeNull();
	});

	test("loadModule recompiles so corrupt source surfaces as an error", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		// Corrupt the file directly on disk.
		await Bun.write(path.join(root, "picker", "source.dsl"), "(defcomponent (");
		await expect(store.loadModule("picker")).rejects.toBeDefined();
	});

	test("listEntries sorts and filters non-conforming names", async () => {
		await store.saveModule("z-last", VALID_SOURCE);
		await store.saveModule("a-first", VALID_SOURCE);
		await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
		await fs.mkdir(path.join(root, "weird name"), { recursive: true });
		expect(await store.listEntries()).toEqual(["a-first", "z-last"]);
	});

	test("listEntries returns [] when the root does not exist yet", async () => {
		const fresh = new DstuiStore({ root: path.join(root, "never-created") });
		expect(await fresh.listEntries()).toEqual([]);
	});

	test("deleteEntry is idempotent and removes the directory tree", async () => {
		await store.saveModule("picker", VALID_SOURCE);
		await store.saveState("picker", { x: 1 });
		await store.deleteEntry("picker");
		expect(await store.loadModule("picker")).toBeNull();
		// Second delete must not throw.
		await store.deleteEntry("picker");
	});

	test("saveModule refuses syntactically invalid DSL", async () => {
		await expect(store.saveModule("picker", "(defcomponent")).rejects.toBeDefined();
		await expect(store.loadModule("picker")).resolves.toBeNull();
	});
});
