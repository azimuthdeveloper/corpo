import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const settingsRow = vi.hoisted(() => ({
	current: {
		id: "default",
		httpProxy: null as string | null,
		httpsProxy: null as string | null,
		noProxy: null as string | null,
		caCertificates: null as string | null,
		proxyBuilds: true,
		proxyContainers: false,
		trustCaInContainers: true,
		updatedAt: new Date(),
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			corpoNetwork: { findFirst: async () => settingsRow.current },
		},
	},
}));

import { lsRemoteHead } from "@dokploy/server/corpo/git-poll";
import {
	networkEnvFor,
	parsePemCertificates,
} from "@dokploy/server/corpo/network";
import {
	dockerDaemonProxySnippet,
	mergeNoProxy,
	panelEnv,
	proxyEnv,
	serviceEnvUpdateArgs,
} from "@dokploy/server/corpo/network-env";

const proxy = {
	httpProxy: "http://proxy.example.internal:8080",
	httpsProxy: null,
	noProxy: ".example.internal, 10.0.0.0/8",
};

describe("proxyEnv", () => {
	it("is empty without a proxy", () => {
		expect(
			proxyEnv({ httpProxy: null, httpsProxy: null, noProxy: "x" }),
		).toEqual({});
	});

	it("sets both cases and falls back between http and https", () => {
		const env = proxyEnv(proxy);
		expect(env.HTTP_PROXY).toBe(proxy.httpProxy);
		expect(env.https_proxy).toBe(proxy.httpProxy);
		expect(env.no_proxy).toBe(env.NO_PROXY);
		expect(env.NO_PROXY?.split(",")).toEqual(
			expect.arrayContaining([
				"localhost",
				"dokploy-postgres",
				".example.internal",
				"10.0.0.0/8",
			]),
		);
	});

	it("dedupes no-proxy entries", () => {
		expect(mergeNoProxy("localhost,localhost, a").split(",")).toEqual([
			...new Set(mergeNoProxy("localhost,localhost, a").split(",")),
		]);
	});
});

describe("panel env", () => {
	it("turns on Node's env proxy support only with a proxy", () => {
		expect(panelEnv(proxy, null).NODE_USE_ENV_PROXY).toBe("1");
		expect(
			panelEnv({ httpProxy: null, httpsProxy: null, noProxy: null }, "/ca")
				.NODE_USE_ENV_PROXY,
		).toBeUndefined();
	});

	it("adds and removes only what changed", () => {
		const desired = panelEnv(proxy, "/etc/dokploy/corpo/ca");
		expect(serviceEnvUpdateArgs(desired, { ...desired })).toEqual([]);
		const args = serviceEnvUpdateArgs(
			{ HTTP_PROXY: "http://new:1" },
			{ HTTP_PROXY: "http://old:1", NODE_EXTRA_CA_CERTS: "/x" },
		);
		expect(args).toEqual([
			"--env-add",
			"HTTP_PROXY=http://new:1",
			"--env-rm",
			"NODE_EXTRA_CA_CERTS",
		]);
	});

	it("ignores variables Corpo does not manage", () => {
		expect(
			serviceEnvUpdateArgs({}, { PATH: "/bin", DATABASE_URL: "x" }),
		).toEqual([]);
	});
});

describe("dockerDaemonProxySnippet", () => {
	it("renders a systemd drop-in only when a proxy is set", () => {
		expect(
			dockerDaemonProxySnippet({
				httpProxy: null,
				httpsProxy: null,
				noProxy: null,
			}),
		).toBeNull();
		expect(dockerDaemonProxySnippet(proxy)).toContain(
			'Environment="HTTPS_PROXY=http://proxy.example.internal:8080"',
		);
	});
});

describe("parsePemCertificates", () => {
	let dir: string;
	let pem: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "corpo-ca-test-"));
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"30",
				"-subj",
				"/CN=Example Internal Root CA",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "ca.pem"),
			],
			{ stdio: "ignore" },
		);
		pem = readFileSync(join(dir, "ca.pem"), "utf8");
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("parses certificates and reports their subject", () => {
		const [cert, ...rest] = parsePemCertificates(`${pem}\n${pem}`);
		expect(rest).toHaveLength(1);
		expect(cert?.subject).toContain("Example Internal Root CA");
		expect(cert?.expired).toBe(false);
	});

	it("rejects private keys and junk", () => {
		const key = readFileSync(join(dir, "key.pem"), "utf8");
		expect(() => parsePemCertificates(`${pem}${key}`)).toThrow(
			"Only PEM certificates",
		);
		expect(() =>
			parsePemCertificates(
				"-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----",
			),
		).toThrow("not a valid PEM certificate");
	});

	it("accepts empty input", () => {
		expect(parsePemCertificates("")).toEqual([]);
		expect(parsePemCertificates(null)).toEqual([]);
	});
});

describe("networkEnvFor", () => {
	it("applies the proxy to builds but not containers by default", async () => {
		settingsRow.current = { ...settingsRow.current, ...proxy };
		expect((await networkEnvFor("build", null)).env.HTTPS_PROXY).toBe(
			proxy.httpProxy,
		);
		expect(
			(await networkEnvFor("runtime", null)).env.HTTPS_PROXY,
		).toBeUndefined();
	});

	it("mounts the CA only for local runtime containers", async () => {
		settingsRow.current = {
			...settingsRow.current,
			caCertificates: "-----BEGIN CERTIFICATE-----",
		};
		const local = await networkEnvFor("runtime", null);
		expect(local.mountCa).toBe(true);
		expect(local.env.SSL_CERT_FILE).toBe("/etc/corpo/ca-bundle.pem");
		expect(local.env.GIT_SSL_CAINFO).toBeUndefined();
		expect((await networkEnvFor("runtime", "remote-server")).mountCa).toBe(
			false,
		);
		expect((await networkEnvFor("build", null)).mountCa).toBe(false);
	});
});

describe("git honours the generated proxy variables", () => {
	it("sends ls-remote through the proxy", async () => {
		const seen: string[] = [];
		const server = createServer((req, res) => {
			seen.push(`${req.method} ${req.url}`);
			res.statusCode = 502;
			res.end();
		});
		server.on("connect", (req, socket) => {
			seen.push(`CONNECT ${req.url}`);
			socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		try {
			await expect(
				lsRemoteHead({
					url: "https://git.example.invalid/org/repo.git",
					branch: "main",
					env: proxyEnv({
						httpProxy: `http://127.0.0.1:${port}`,
						httpsProxy: null,
						noProxy: null,
					}),
					secrets: [],
					cleanup: async () => {},
				}),
			).rejects.toThrow();
		} finally {
			server.close();
		}
		expect(seen).toContain("CONNECT git.example.invalid:443");
	});
});
