import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const baseDir = vi.hoisted(() => ({ path: "" }));

vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	paths: () => ({ BASE_PATH: baseDir.path }),
}));

import { lsRemoteHead } from "@dokploy/server/corpo/git-poll";
import { writeCaFiles } from "@dokploy/server/corpo/network";
import { caEnv } from "@dokploy/server/corpo/network-env";

const openssl = (cwd: string, ...args: string[]) =>
	execFileSync("openssl", args, { cwd, stdio: "ignore" });

describe("internal CA bundle", () => {
	let dir: string;
	let caPem: string;
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "corpo-ca-e2e-"));
		baseDir.path = join(dir, "etc-dokploy");
		openssl(
			dir,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"2",
			"-subj",
			"/CN=Corpo Test Root CA",
			"-keyout",
			"ca.key",
			"-out",
			"ca.pem",
		);
		openssl(
			dir,
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			"/CN=localhost",
			"-keyout",
			"server.key",
			"-out",
			"server.csr",
		);
		writeFileSync(
			join(dir, "san.ext"),
			"subjectAltName=DNS:localhost,IP:127.0.0.1\n",
		);
		openssl(
			dir,
			"x509",
			"-req",
			"-in",
			"server.csr",
			"-CA",
			"ca.pem",
			"-CAkey",
			"ca.key",
			"-CAcreateserial",
			"-days",
			"2",
			"-extfile",
			"san.ext",
			"-out",
			"server.pem",
		);
		caPem = readFileSync(join(dir, "ca.pem"), "utf8");

		server = createServer(
			{
				key: readFileSync(join(dir, "server.key")),
				cert: readFileSync(join(dir, "server.pem")),
			},
			(_req, res) => {
				res.statusCode = 404;
				res.end();
			},
		);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		port = (server.address() as AddressInfo).port;
	});

	afterAll(() => {
		server?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const lsRemote = (env: Record<string, string>) =>
		lsRemoteHead({
			url: `https://localhost:${port}/org/repo.git`,
			branch: "main",
			env,
			secrets: [],
			cleanup: async () => {},
		});

	it("git rejects the internal server without the bundle", async () => {
		await expect(lsRemote({ GIT_SSL_CAINFO: "/nonexistent" })).rejects.toThrow(
			/SSL|certificate|CAfile|CA file/i,
		);
	});

	it("git trusts the internal server with the bundle Corpo writes", async () => {
		const written = await writeCaFiles({
			id: "default",
			httpProxy: null,
			httpsProxy: null,
			noProxy: null,
			caCertificates: caPem,
			proxyBuilds: true,
			proxyContainers: false,
			trustCaInContainers: true,
			updatedAt: new Date(),
		});
		expect(written).toBe(join(baseDir.path, "corpo", "ca"));
		const error = await lsRemote({
			GIT_SSL_CAINFO: caEnv(written!).GIT_SSL_CAINFO!,
		}).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toMatch(/SSL|certificate/i);
		expect((error as Error).message).toMatch(/404|not found/i);
	});

	it("removes the files when the CA is cleared", async () => {
		const result = await writeCaFiles({
			id: "default",
			httpProxy: null,
			httpsProxy: null,
			noProxy: null,
			caCertificates: null,
			proxyBuilds: true,
			proxyContainers: false,
			trustCaInContainers: true,
			updatedAt: new Date(),
		});
		expect(result).toBeNull();
	});
});
