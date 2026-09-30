export const normalizeRoutePath = (path: string | null | undefined) => {
	const trimmed = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}` : null;
};

// A bare PathPrefix(`/cor-app`) also matches `/cor-application`, which would let
// one IIS route shadow another, so match the exact path or the path plus a slash.
export const buildHostPathRule = (host: string, path: string | null) => {
	const hostRule = `Host(\`${host}\`)`;
	const normalized = normalizeRoutePath(path);
	if (!normalized) {
		return hostRule;
	}
	return `${hostRule} && (Path(\`${normalized}\`) || PathPrefix(\`${normalized}/\`))`;
};

export const slashRedirectMiddlewareName = (
	appName: string,
	uniqueConfigKey: number,
) => `corpo-slash-${appName}-${uniqueConfigKey}`;

const escapeRegex = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// With stripPath on, `/cor-app` is forwarded as `/` and the browser resolves
// relative asset URLs against `/`, so send it to `/cor-app/` first. The
// replacement is a relative URL so the redirect stays correct behind IIS,
// whichever scheme and host the client used.
export const buildSlashRedirectMiddleware = (path: string) => {
	const normalized = normalizeRoutePath(path);
	if (!normalized) {
		return null;
	}
	return {
		redirectRegex: {
			regex: `^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+(${escapeRegex(normalized)})(\\?.*)?$`,
			replacement: "${1}/${2}",
			permanent: false,
		},
	};
};

export const slugToRoutePath = (prefix: string, slug: string) => {
	const cleanSlug = slug
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!cleanSlug) {
		return null;
	}
	const cleanPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
	const segment = cleanSlug.startsWith(cleanPrefix)
		? cleanSlug
		: `${cleanPrefix}${cleanSlug}`;
	return `/${segment}`;
};

export const buildPublicUrl = (
	scheme: string,
	host: string,
	path: string | null,
) => `${scheme}://${host}${normalizeRoutePath(path) ?? ""}`;
