// Imported by client components, so this module must stay free of server-only imports.

export interface ProxySettings {
	httpProxy: string | null;
	httpsProxy: string | null;
	noProxy: string | null;
}

// Traffic to the panel's own services and to loopback must never go through
// the corporate proxy.
export const BUILTIN_NO_PROXY = [
	"localhost",
	"127.0.0.1",
	"::1",
	"dokploy-postgres",
	"dokploy-redis",
	"dokploy-traefik",
	"dokploy-monitoring",
];

export const mergeNoProxy = (userValue: string | null | undefined) => {
	const entries = [...BUILTIN_NO_PROXY, ...(userValue ?? "").split(/[\s,]+/)]
		.map((entry) => entry.trim())
		.filter(Boolean);
	return [...new Set(entries)].join(",");
};

export const hasProxy = (settings: ProxySettings) =>
	!!(settings.httpProxy || settings.httpsProxy);

// Tools disagree on case (curl/git read lowercase, Docker and most runtimes
// uppercase), so set both.
export const proxyEnv = (settings: ProxySettings): Record<string, string> => {
	if (!hasProxy(settings)) {
		return {};
	}
	const env: Record<string, string> = {};
	const httpProxy = settings.httpProxy || settings.httpsProxy!;
	const httpsProxy = settings.httpsProxy || settings.httpProxy!;
	const noProxy = mergeNoProxy(settings.noProxy);
	for (const [key, value] of [
		["HTTP_PROXY", httpProxy],
		["HTTPS_PROXY", httpsProxy],
		["NO_PROXY", noProxy],
	] as const) {
		env[key] = value;
		env[key.toLowerCase()] = value;
	}
	return env;
};

export const CONTAINER_CA_DIR = "/etc/corpo";
export const CA_BUNDLE_FILE = "ca-bundle.pem";
export const CA_CUSTOM_FILE = "ca-custom.pem";

// The bundle file holds the public roots plus the internal CA, so it can
// replace a runtime's default store; the custom file only adds to it.
export const caEnv = (dir: string): Record<string, string> => ({
	NODE_EXTRA_CA_CERTS: `${dir}/${CA_CUSTOM_FILE}`,
	SSL_CERT_FILE: `${dir}/${CA_BUNDLE_FILE}`,
	REQUESTS_CA_BUNDLE: `${dir}/${CA_BUNDLE_FILE}`,
	CURL_CA_BUNDLE: `${dir}/${CA_BUNDLE_FILE}`,
	GIT_SSL_CAINFO: `${dir}/${CA_BUNDLE_FILE}`,
});

export const PANEL_MANAGED_ENV_KEYS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"GIT_SSL_CAINFO",
] as const;

export const panelEnv = (
	settings: ProxySettings,
	caDir: string | null,
): Record<string, string> => {
	const env: Record<string, string> = { ...proxyEnv(settings) };
	if (hasProxy(settings)) {
		env.NODE_USE_ENV_PROXY = "1";
	}
	if (caDir) {
		const ca = caEnv(caDir);
		env.NODE_EXTRA_CA_CERTS = ca.NODE_EXTRA_CA_CERTS!;
		env.GIT_SSL_CAINFO = ca.GIT_SSL_CAINFO!;
	}
	return env;
};

export const serviceEnvUpdateArgs = (
	desired: Record<string, string>,
	current: Record<string, string | undefined>,
	keys: readonly string[] = PANEL_MANAGED_ENV_KEYS,
) => {
	const args: string[] = [];
	for (const key of keys) {
		const want = desired[key];
		const have = current[key];
		if (want !== undefined && want !== have) {
			args.push("--env-add", `${key}=${want}`);
		} else if (want === undefined && have !== undefined) {
			args.push("--env-rm", key);
		}
	}
	return args;
};

export const dockerDaemonProxySnippet = (settings: ProxySettings) => {
	if (!hasProxy(settings)) {
		return null;
	}
	const env = proxyEnv(settings);
	return `# /etc/systemd/system/docker.service.d/http-proxy.conf
[Service]
Environment="HTTP_PROXY=${env.HTTP_PROXY}"
Environment="HTTPS_PROXY=${env.HTTPS_PROXY}"
Environment="NO_PROXY=${env.NO_PROXY}"

# then:
sudo systemctl daemon-reload && sudo systemctl restart docker`;
};

// The installer starts the panel with the proxy/CA already in its environment;
// on first boot, record that in the settings so the UI shows it and saving the
// page doesn't strip it.
export const networkSeedFromEnv = (
	env: Record<string, string | undefined>,
): ProxySettings => {
	const builtin = new Set(BUILTIN_NO_PROXY);
	const userNoProxy = (env.NO_PROXY || env.no_proxy || "")
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry && !builtin.has(entry));
	return {
		httpProxy: env.HTTP_PROXY || env.http_proxy || null,
		httpsProxy: env.HTTPS_PROXY || env.https_proxy || null,
		noProxy: userNoProxy.length > 0 ? userNoProxy.join(",") : null,
	};
};
