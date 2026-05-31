/**
 * Filesystem-backed persistence for compiled `pi-dstui` modules.
 *
 * Layout per name:
 * ```
 *   <root>/<name>/source.dsl   // raw DSL text
 *   <root>/<name>/state.json   // optional last-known state blob
 * ```
 *
 * The store deliberately stays small: it knows how to write, read,
 * delete, and list entries — nothing else. Hot-reload semantics live
 * in the chunk-4 tool wiring; this layer only guarantees that what
 * goes onto disk is safe to read back later.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileModule, type DstuiLimits, type ModuleDef } from "@oh-my-pi/pi-dstui";
import { isEnoent } from "@oh-my-pi/pi-utils";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Default per-blob caps. */
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024;
const DEFAULT_MAX_STATE_BYTES = 64 * 1024;

/** Configuration accepted by {@link DstuiStore}. */
export interface DstuiStoreOptions {
	/** Root directory. Created on demand. */
	root: string;
	/** Max source bytes accepted by `saveModule`. Default 64 KiB. */
	maxSourceBytes?: number;
	/** Max state bytes accepted by `saveState`. Default 64 KiB. */
	maxStateBytes?: number;
	/** Overlay onto `DstuiLimits` used when re-compiling on load. */
	limits?: Partial<DstuiLimits>;
}

/** Persistent record returned by {@link DstuiStore.loadModule}. */
export interface StoreEntry {
	name: string;
	source: string;
	module: ModuleDef;
	state: unknown;
}

/** Thrown when a name does not match the allowed pattern. */
export class StoreNameError extends Error {
	constructor(name: string) {
		super(`invalid dstui store name "${name}" — must match ${NAME_PATTERN}`);
		this.name = "StoreNameError";
	}
}

/** Thrown when a blob exceeds the configured size cap. */
export class StoreQuotaError extends Error {
	constructor(field: "source" | "state", bytes: number, limit: number) {
		super(`dstui store ${field} blob (${bytes} bytes) exceeds limit (${limit} bytes)`);
		this.name = "StoreQuotaError";
	}
}

/** Thrown when a state blob is not JSON-encodable (function, symbol, BigInt, etc.). */
export class StoreEncodingError extends Error {
	constructor(reason: string) {
		super(`dstui store state is not JSON-encodable: ${reason}`);
		this.name = "StoreEncodingError";
	}
}

function assertName(name: string): void {
	if (!NAME_PATTERN.test(name)) throw new StoreNameError(name);
}
const ENCODER = new TextEncoder();

function byteLength(text: string): number {
	return ENCODER.encode(text).byteLength;
}

async function writeAtomic(target: string, content: string): Promise<void> {
	const tmp = `${target}.tmp`;
	await Bun.write(tmp, content);
	await fs.rename(tmp, target);
}

async function readOrNull(target: string): Promise<string | null> {
	try {
		return await Bun.file(target).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/**
 * Persistent store for compiled DSL modules and their last-known state.
 *
 * `DstuiStore` is intentionally stateless; every operation hits the
 * filesystem so multiple processes/sessions converge on the same view
 * without an in-memory cache to invalidate.
 */
export class DstuiStore {
	readonly root: string;
	readonly #maxSourceBytes: number;
	readonly #maxStateBytes: number;
	readonly #limits?: Partial<DstuiLimits>;

	constructor(options: DstuiStoreOptions) {
		this.root = options.root;
		this.#maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
		this.#maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES;
		this.#limits = options.limits;
	}

	/** Absolute path to the named entry directory. */
	pathFor(name: string): string {
		assertName(name);
		return path.join(this.root, name);
	}

	/** Persist DSL source for `name`. Overwrites any prior source. */
	async saveModule(name: string, source: string): Promise<void> {
		const bytes = byteLength(source);
		if (bytes > this.#maxSourceBytes) {
			throw new StoreQuotaError("source", bytes, this.#maxSourceBytes);
		}
		// Compile-check so invalid source never lands on disk.
		compileModule(source, { limits: this.#limits });
		const dir = this.pathFor(name);
		await fs.mkdir(dir, { recursive: true });
		await writeAtomic(path.join(dir, "source.dsl"), source);
	}

	/** Persist `state` for `name`. Encoded as JSON; `undefined` clears. */
	async saveState(name: string, state: unknown): Promise<void> {
		const dir = this.pathFor(name);
		const target = path.join(dir, "state.json");
		if (state === undefined) {
			await fs.rm(target, { force: true });
			return;
		}
		let encoded: string | undefined;
		try {
			encoded = JSON.stringify(state);
		} catch (err) {
			throw new StoreEncodingError(err instanceof Error ? err.message : String(err));
		}
		if (typeof encoded !== "string") {
			throw new StoreEncodingError(
				`JSON.stringify returned ${encoded === undefined ? "undefined" : typeof encoded}`,
			);
		}
		const bytes = byteLength(encoded);
		if (bytes > this.#maxStateBytes) {
			throw new StoreQuotaError("state", bytes, this.#maxStateBytes);
		}
		await fs.mkdir(dir, { recursive: true });
		await writeAtomic(target, encoded);
	}

	/**
	 * Read and recompile `name`. Returns `null` when no module is
	 * stored. Re-throws any compile error from the loaded source.
	 */
	async loadModule(name: string): Promise<StoreEntry | null> {
		const dir = this.pathFor(name);
		const source = await readOrNull(path.join(dir, "source.dsl"));
		if (source === null) return null;
		const module = compileModule(source, { limits: this.#limits });
		const rawState = await readOrNull(path.join(dir, "state.json"));
		const state = rawState === null ? undefined : JSON.parse(rawState);
		return { name, source, module, state };
	}

	/** Delete an entry and everything under it. Idempotent. */
	async deleteEntry(name: string): Promise<void> {
		await fs.rm(this.pathFor(name), { recursive: true, force: true });
	}

	/** List every stored entry name in lexicographic order. */
	async listEntries(): Promise<string[]> {
		try {
			const dirents = await fs.readdir(this.root, { withFileTypes: true });
			return dirents
				.filter(d => d.isDirectory() && NAME_PATTERN.test(d.name))
				.map(d => d.name)
				.sort();
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}
}
