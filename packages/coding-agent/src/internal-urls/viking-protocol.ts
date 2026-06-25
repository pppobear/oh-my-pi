import { Settings } from "../config/settings";
import { OpenVikingApi } from "../openviking/client";
import { loadOpenVikingConfig } from "../openviking/config";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

function settingsFromContext(context?: ResolveContext): Settings {
	return context?.settings instanceof Settings ? context.settings : Settings.instance;
}

function contentTypeForUri(uri: string): InternalResource["contentType"] {
	const pathname = uri.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
	if (pathname.endsWith(".md")) return "text/markdown";
	if (pathname.endsWith(".json")) return "application/json";
	return "text/plain";
}

function vikingUriFromInternalUrl(url: InternalUrl): string {
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	const rawPathname = url.rawPathname ?? url.pathname;
	let pathname = rawPathname;
	try {
		pathname = decodeURIComponent(rawPathname);
	} catch {
		pathname = rawPathname;
	}
	return `${scheme}://${url.rawHost ?? url.hostname}${pathname}${url.search}${url.hash}`;
}

/** Resolve OpenViking viking:// content through the configured OpenViking API. */
export class VikingProtocolHandler implements ProtocolHandler {
	readonly scheme = "viking";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const settings = settingsFromContext(context);
		const config = await loadOpenVikingConfig(settings);
		const client = new OpenVikingApi(config);
		const uri = vikingUriFromInternalUrl(url);
		const content = await client.readContent(uri);
		if (content === null) {
			throw new Error(`OpenViking content not found or unavailable: ${uri}`);
		}
		return {
			url: uri,
			content,
			contentType: contentTypeForUri(uri),
			size: Buffer.byteLength(content, "utf-8"),
			notes: ["OpenViking content"],
		};
	}
}
