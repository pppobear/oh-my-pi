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

interface OpenVikingConnectionProfile {
	baseUrl: string;
	apiKey?: string;
	accountId?: string;
	userId?: string;
	peerId?: string;
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

function finiteNumberFromUnknown(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function numberFromUnknown(value: unknown, fallback: number): number {
	return finiteNumberFromUnknown(value) ?? fallback;
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

type OpenVikingEnvironmentValue = string | boolean | number;

interface OpenVikingEnvironmentSetting {
	names: readonly string[];
	parse(value: string | undefined): OpenVikingEnvironmentValue | undefined;
}

const OPENVIKING_ENVIRONMENT_SETTINGS: Partial<Record<SettingPath, OpenVikingEnvironmentSetting>> = {
	"openviking.apiUrl": { names: ["OPENVIKING_URL", "OPENVIKING_BASE_URL"], parse: asString },
	"openviking.apiKey": { names: ["OPENVIKING_BEARER_TOKEN", "OPENVIKING_API_KEY"], parse: asString },
	"openviking.account": { names: ["OPENVIKING_ACCOUNT"], parse: asString },
	"openviking.user": { names: ["OPENVIKING_USER"], parse: asString },
	"openviking.peerId": { names: ["OPENVIKING_PEER_ID"], parse: asString },
	"openviking.autoRecall": { names: ["OPENVIKING_AUTO_RECALL"], parse: boolFromUnknown },
	"openviking.autoRetain": { names: ["OPENVIKING_AUTO_CAPTURE"], parse: boolFromUnknown },
	"openviking.recallLimit": { names: ["OPENVIKING_RECALL_LIMIT"], parse: finiteNumberFromUnknown },
	"openviking.scoreThreshold": { names: ["OPENVIKING_SCORE_THRESHOLD"], parse: finiteNumberFromUnknown },
	"openviking.minQueryLength": { names: ["OPENVIKING_MIN_QUERY_LENGTH"], parse: finiteNumberFromUnknown },
	"openviking.recallMaxContentChars": {
		names: ["OPENVIKING_RECALL_MAX_CONTENT_CHARS"],
		parse: finiteNumberFromUnknown,
	},
	"openviking.recallTokenBudget": {
		names: ["OPENVIKING_RECALL_TOKEN_BUDGET"],
		parse: finiteNumberFromUnknown,
	},
	"openviking.recallPreferAbstract": {
		names: ["OPENVIKING_RECALL_PREFER_ABSTRACT"],
		parse: boolFromUnknown,
	},
	"openviking.captureAssistantTurns": {
		names: ["OPENVIKING_CAPTURE_ASSISTANT_TURNS"],
		parse: boolFromUnknown,
	},
	"openviking.timeoutMs": { names: ["OPENVIKING_TIMEOUT_MS"], parse: finiteNumberFromUnknown },
	"openviking.captureTimeoutMs": {
		names: ["OPENVIKING_CAPTURE_TIMEOUT_MS"],
		parse: finiteNumberFromUnknown,
	},
	"openviking.debug": { names: ["OPENVIKING_DEBUG"], parse: boolFromUnknown },
};

function resolveOpenVikingEnvironmentSetting(
	path: SettingPath,
	env: NodeJS.ProcessEnv,
): { name: string; value: OpenVikingEnvironmentValue } | undefined {
	const setting = OPENVIKING_ENVIRONMENT_SETTINGS[path];
	if (!setting) return undefined;
	for (const name of setting.names) {
		const value = setting.parse(env[name]);
		if (value !== undefined) return { name, value };
	}
	return undefined;
}

export function getOpenVikingEnvironmentVariable(
	path: SettingPath,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return resolveOpenVikingEnvironmentSetting(path, env)?.name;
}

function openVikingEnvironmentString(path: SettingPath, env: NodeJS.ProcessEnv): string | undefined {
	const value = resolveOpenVikingEnvironmentSetting(path, env)?.value;
	return typeof value === "string" ? value : undefined;
}

function openVikingEnvironmentBoolean(path: SettingPath, env: NodeJS.ProcessEnv): boolean | undefined {
	const value = resolveOpenVikingEnvironmentSetting(path, env)?.value;
	return typeof value === "boolean" ? value : undefined;
}

function openVikingEnvironmentNumber(path: SettingPath, env: NodeJS.ProcessEnv): number | undefined {
	const value = resolveOpenVikingEnvironmentSetting(path, env)?.value;
	return typeof value === "number" ? value : undefined;
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
	const cliBaseUrl = asString(cli?.url)?.replace(/\/+$/, "");
	const cliProfile: OpenVikingConnectionProfile | null = cliBaseUrl
		? {
				baseUrl: cliBaseUrl,
				apiKey: asString(cli?.api_key),
				accountId: asString(cli?.account),
				userId: asString(cli?.user),
			}
		: null;
	const legacyProfile: OpenVikingConnectionProfile | null = legacy
		? {
				baseUrl: server ? baseUrlFromLegacyServer(server) : DEFAULT_BASE_URL,
				apiKey: asString(cc?.apiKey) ?? asString(server?.root_api_key),
				accountId: asString(cc?.accountId),
				userId: asString(cc?.userId),
				peerId: asString(cc?.peerId) ?? asString(cc?.peer_id),
			}
		: null;
	const explicitBaseUrl =
		openVikingEnvironmentString("openviking.apiUrl", env) ?? configuredStringSetting(settings, "openviking.apiUrl");
	// Treat discovered connection details as an atomic profile. In particular,
	// never pair an ovcli URL with ov.conf's server root key. An explicit OMP or
	// environment credential remains a deliberate override for any URL. Keep a
	// discovered profile only when an explicit URL names that exact same server;
	// this makes a no-op Settings edit preserve the matching profile credential
	// without ever carrying it to a different origin.
	const normalizedExplicitBaseUrl = explicitBaseUrl?.replace(/\/+$/, "");
	const officialProfile = cliProfile ?? legacyProfile;
	const discoveredProfile =
		normalizedExplicitBaseUrl && officialProfile?.baseUrl !== normalizedExplicitBaseUrl ? null : officialProfile;
	const baseUrl = normalizedExplicitBaseUrl ?? discoveredProfile?.baseUrl ?? DEFAULT_BASE_URL;

	const timeoutMs = intAtLeast(
		openVikingEnvironmentNumber("openviking.timeoutMs", env) ??
			resolveConfigValue(configuredSetting(settings, "openviking.timeoutMs"), cc?.timeoutMs),
		15_000,
		1_000,
	);
	const captureTimeoutMs = intAtLeast(
		openVikingEnvironmentNumber("openviking.captureTimeoutMs", env) ??
			resolveConfigValue(configuredSetting(settings, "openviking.captureTimeoutMs"), cc?.captureTimeoutMs),
		Math.max(timeoutMs * 2, 30_000),
		1_000,
	);

	return {
		baseUrl,
		apiKey:
			openVikingEnvironmentString("openviking.apiKey", env) ??
			configuredStringSetting(settings, "openviking.apiKey") ??
			discoveredProfile?.apiKey ??
			null,
		accountId:
			openVikingEnvironmentString("openviking.account", env) ??
			configuredStringSetting(settings, "openviking.account") ??
			discoveredProfile?.accountId ??
			null,
		userId:
			openVikingEnvironmentString("openviking.user", env) ??
			configuredStringSetting(settings, "openviking.user") ??
			discoveredProfile?.userId ??
			null,
		peerId:
			openVikingEnvironmentString("openviking.peerId", env) ??
			configuredStringSetting(settings, "openviking.peerId") ??
			discoveredProfile?.peerId ??
			null,
		timeoutMs,
		captureTimeoutMs,
		autoRecall:
			openVikingEnvironmentBoolean("openviking.autoRecall", env) ??
			resolveConfigValue(configuredSetting(settings, "openviking.autoRecall"), boolFromUnknown(cc?.autoRecall)) ??
			true,
		autoRetain:
			openVikingEnvironmentBoolean("openviking.autoRetain", env) ??
			resolveConfigValue(configuredSetting(settings, "openviking.autoRetain"), boolFromUnknown(cc?.autoCapture)) ??
			true,
		recallLimit: intAtLeast(
			openVikingEnvironmentNumber("openviking.recallLimit", env) ??
				resolveConfigValue(configuredSetting(settings, "openviking.recallLimit"), cc?.recallLimit),
			6,
			1,
		),
		scoreThreshold: clamped(
			openVikingEnvironmentNumber("openviking.scoreThreshold", env) ??
				resolveConfigValue(configuredSetting(settings, "openviking.scoreThreshold"), cc?.scoreThreshold),
			0.35,
			0,
			1,
		),
		minQueryLength: intAtLeast(
			openVikingEnvironmentNumber("openviking.minQueryLength", env) ??
				resolveConfigValue(configuredSetting(settings, "openviking.minQueryLength"), cc?.minQueryLength),
			3,
			1,
		),
		recallMaxContentChars: intAtLeast(
			openVikingEnvironmentNumber("openviking.recallMaxContentChars", env) ??
				resolveConfigValue(
					configuredSetting(settings, "openviking.recallMaxContentChars"),
					cc?.recallMaxContentChars,
				),
			500,
			50,
		),
		recallTokenBudget: intAtLeast(
			openVikingEnvironmentNumber("openviking.recallTokenBudget", env) ??
				resolveConfigValue(configuredSetting(settings, "openviking.recallTokenBudget"), cc?.recallTokenBudget),
			2_000,
			200,
		),
		recallPreferAbstract:
			openVikingEnvironmentBoolean("openviking.recallPreferAbstract", env) ??
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
			openVikingEnvironmentBoolean("openviking.captureAssistantTurns", env) ??
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
			openVikingEnvironmentBoolean("openviking.debug", env) ??
			resolveConfigValue(configuredSetting(settings, "openviking.debug"), boolFromUnknown(cc?.debug)) ??
			false,
	};
}
