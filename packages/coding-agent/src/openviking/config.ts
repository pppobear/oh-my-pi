import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { SettingPath, SettingValue } from "../config/settings-schema";

export interface OpenVikingConfig {
	baseUrl: string;
	apiKey: string | null;
	accountId: string | null;
	userId: string | null;
	peerId: string | null;
	timeoutMs: number;
	captureTimeoutMs: number;
	autoRecall: boolean;
	autoRetain: boolean;
	recallLimit: number;
	scoreThreshold: number;
	minQueryLength: number;
	recallMaxContentChars: number;
	recallTokenBudget: number;
	recallPreferAbstract: boolean;
	recallContextTurns: number;
	captureAssistantTurns: boolean;
	commitEveryNTurns: number;
	debug: boolean;
}

interface OpenVikingCliConfigFile {
	url?: unknown;
	api_key?: unknown;
	account?: unknown;
	user?: unknown;
}

interface OpenVikingLegacyConfigFile {
	server?: {
		url?: unknown;
		host?: unknown;
		port?: unknown;
		root_api_key?: unknown;
	};
	claude_code?: {
		apiKey?: unknown;
		accountId?: unknown;
		userId?: unknown;
		peerId?: unknown;
		peer_id?: unknown;
		timeoutMs?: unknown;
		captureTimeoutMs?: unknown;
		autoRecall?: unknown;
		autoCapture?: unknown;
		recallLimit?: unknown;
		scoreThreshold?: unknown;
		minQueryLength?: unknown;
		recallMaxContentChars?: unknown;
		recallTokenBudget?: unknown;
		recallPreferAbstract?: unknown;
		recallContextTurns?: unknown;
		captureAssistantTurns?: unknown;
		commitEveryNTurns?: unknown;
		debug?: unknown;
	};
}

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_OV_CONF_PATH = "~/.openviking/ov.conf";
const DEFAULT_OVCLI_CONF_PATH = "~/.openviking/ovcli.conf";

function expandTilde(input: string): string {
	return input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function envString(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = asString(env[name]);
		if (value) return value;
	}
	return undefined;
}

function boolFromUnknown(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "0" || lower === "false" || lower === "no") return false;
	if (lower === "1" || lower === "true" || lower === "yes") return true;
	return undefined;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
	return boolFromUnknown(value);
}

function numberFromUnknown(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function intAtLeast(value: unknown, fallback: number, min: number): number {
	return Math.max(min, Math.floor(numberFromUnknown(value, fallback)));
}

function clamped(value: unknown, fallback: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, numberFromUnknown(value, fallback)));
}

function configuredSetting<P extends SettingPath>(settings: Settings, path: P): SettingValue<P> | undefined {
	return settings.isConfigured(path) ? settings.get(path) : undefined;
}

function configuredStringSetting(settings: Settings, path: SettingPath): string | undefined {
	return settings.isConfigured(path) ? asString(settings.get(path)) : undefined;
}

function resolveConfigValue<T>(ompValue: T | undefined, officialValue: T | undefined): T | undefined {
	return ompValue ?? officialValue;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(expandTilde(filePath)).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return null;
		logger.debug("OpenViking: config file ignored", { path: filePath, error: String(error) });
		return null;
	}
}

function baseUrlFromLegacyServer(server: OpenVikingLegacyConfigFile["server"]): string {
	const explicit = asString(server?.url);
	if (explicit) return explicit.replace(/\/+$/, "");
	const host = (asString(server?.host) ?? "127.0.0.1").replace("0.0.0.0", "127.0.0.1");
	const port = Math.floor(numberFromUnknown(server?.port, 1933));
	return `http://${host}:${port}`;
}

export async function loadOpenVikingConfig(
	settings: Settings,
	env: NodeJS.ProcessEnv = process.env,
): Promise<OpenVikingConfig> {
	const ovConfPath = envString(env, "OPENVIKING_CONFIG_FILE") ?? DEFAULT_OV_CONF_PATH;
	const ovCliConfPath = envString(env, "OPENVIKING_CLI_CONFIG_FILE") ?? DEFAULT_OVCLI_CONF_PATH;
	const [legacy, cli] = await Promise.all([
		readJsonFile<OpenVikingLegacyConfigFile>(ovConfPath),
		readJsonFile<OpenVikingCliConfigFile>(ovCliConfPath),
	]);
	const server = legacy?.server;
	const cc = legacy?.claude_code;
	const officialBaseUrl = asString(cli?.url) ?? (server ? baseUrlFromLegacyServer(server) : undefined);
	const baseUrl = (
		envString(env, "OPENVIKING_URL", "OPENVIKING_BASE_URL") ??
		resolveConfigValue(configuredStringSetting(settings, "openviking.apiUrl"), officialBaseUrl) ??
		DEFAULT_BASE_URL
	).replace(/\/+$/, "");

	const timeoutMs = intAtLeast(
		env.OPENVIKING_TIMEOUT_MS ??
			resolveConfigValue(configuredSetting(settings, "openviking.timeoutMs"), cc?.timeoutMs),
		15_000,
		1_000,
	);
	const captureTimeoutMs = intAtLeast(
		env.OPENVIKING_CAPTURE_TIMEOUT_MS ??
			resolveConfigValue(configuredSetting(settings, "openviking.captureTimeoutMs"), cc?.captureTimeoutMs),
		Math.max(timeoutMs * 2, 30_000),
		1_000,
	);

	return {
		baseUrl,
		apiKey:
			envString(env, "OPENVIKING_BEARER_TOKEN", "OPENVIKING_API_KEY") ??
			resolveConfigValue(
				configuredStringSetting(settings, "openviking.apiKey"),
				asString(cli?.api_key) ?? asString(cc?.apiKey) ?? asString(server?.root_api_key),
			) ??
			null,
		accountId:
			envString(env, "OPENVIKING_ACCOUNT") ??
			resolveConfigValue(
				configuredStringSetting(settings, "openviking.account"),
				asString(cli?.account) ?? asString(cc?.accountId),
			) ??
			null,
		userId:
			envString(env, "OPENVIKING_USER") ??
			resolveConfigValue(
				configuredStringSetting(settings, "openviking.user"),
				asString(cli?.user) ?? asString(cc?.userId),
			) ??
			null,
		peerId:
			envString(env, "OPENVIKING_PEER_ID") ??
			resolveConfigValue(
				configuredStringSetting(settings, "openviking.peerId"),
				asString(cc?.peerId) ?? asString(cc?.peer_id),
			) ??
			null,
		timeoutMs,
		captureTimeoutMs,
		autoRecall:
			boolFromEnv(env.OPENVIKING_AUTO_RECALL) ??
			resolveConfigValue(configuredSetting(settings, "openviking.autoRecall"), boolFromUnknown(cc?.autoRecall)) ??
			true,
		autoRetain:
			boolFromEnv(env.OPENVIKING_AUTO_CAPTURE) ??
			resolveConfigValue(configuredSetting(settings, "openviking.autoRetain"), boolFromUnknown(cc?.autoCapture)) ??
			true,
		recallLimit: intAtLeast(
			env.OPENVIKING_RECALL_LIMIT ??
				resolveConfigValue(configuredSetting(settings, "openviking.recallLimit"), cc?.recallLimit),
			6,
			1,
		),
		scoreThreshold: clamped(
			env.OPENVIKING_SCORE_THRESHOLD ??
				resolveConfigValue(configuredSetting(settings, "openviking.scoreThreshold"), cc?.scoreThreshold),
			0.35,
			0,
			1,
		),
		minQueryLength: intAtLeast(
			env.OPENVIKING_MIN_QUERY_LENGTH ??
				resolveConfigValue(configuredSetting(settings, "openviking.minQueryLength"), cc?.minQueryLength),
			3,
			1,
		),
		recallMaxContentChars: intAtLeast(
			env.OPENVIKING_RECALL_MAX_CONTENT_CHARS ??
				resolveConfigValue(
					configuredSetting(settings, "openviking.recallMaxContentChars"),
					cc?.recallMaxContentChars,
				),
			500,
			50,
		),
		recallTokenBudget: intAtLeast(
			env.OPENVIKING_RECALL_TOKEN_BUDGET ??
				resolveConfigValue(configuredSetting(settings, "openviking.recallTokenBudget"), cc?.recallTokenBudget),
			2_000,
			200,
		),
		recallPreferAbstract:
			boolFromEnv(env.OPENVIKING_RECALL_PREFER_ABSTRACT) ??
			resolveConfigValue(
				configuredSetting(settings, "openviking.recallPreferAbstract"),
				boolFromUnknown(cc?.recallPreferAbstract),
			) ??
			true,
		recallContextTurns: intAtLeast(
			resolveConfigValue(configuredSetting(settings, "openviking.recallContextTurns"), cc?.recallContextTurns),
			6,
			1,
		),
		captureAssistantTurns:
			boolFromEnv(env.OPENVIKING_CAPTURE_ASSISTANT_TURNS) ??
			resolveConfigValue(
				configuredSetting(settings, "openviking.captureAssistantTurns"),
				boolFromUnknown(cc?.captureAssistantTurns),
			) ??
			true,
		commitEveryNTurns: intAtLeast(
			resolveConfigValue(configuredSetting(settings, "openviking.commitEveryNTurns"), cc?.commitEveryNTurns),
			4,
			1,
		),
		debug:
			boolFromEnv(env.OPENVIKING_DEBUG) ??
			resolveConfigValue(configuredSetting(settings, "openviking.debug"), boolFromUnknown(cc?.debug)) ??
			false,
	};
}
