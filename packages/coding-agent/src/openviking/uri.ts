export interface MemoryUrlParts {
	rawHost?: string;
	hostname: string;
	rawPathname?: string;
	pathname: string;
	search: string;
	hash: string;
}

export function openVikingUriFromMemoryUrl(url: MemoryUrlParts): string {
	const rawPathname = url.rawPathname ?? url.pathname;
	let pathname = rawPathname;
	try {
		pathname = decodeURIComponent(rawPathname);
	} catch {
		pathname = rawPathname;
	}
	return `viking://${url.rawHost ?? url.hostname}${pathname}${url.search}${url.hash}`;
}

export function memoryUriFromOpenVikingUri(uri: string): string {
	return uri.replace(/^viking:\/\//i, "memory://");
}
