import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import { IS_CLOUD, paths } from "../constants";
import {
	CA_BUNDLE_FILE,
	CA_CUSTOM_FILE,
	CONTAINER_CA_DIR,
	caEnv,
	PANEL_MANAGED_ENV_KEYS,
	panelEnv,
	proxyEnv,
	serviceEnvUpdateArgs,
} from "./network-env";
import { corpoNetwork } from "./schema";

const execFileAsync = promisify(execFile);

export type NetworkSettings = typeof corpoNetwork.$inferSelect;

export const getNetworkSettings = async (): Promise<NetworkSettings> => {
	const existing = await db.query.corpoNetwork.findFirst({
		where: eq(corpoNetwork.id, "default"),
	});
	if (existing) return existing;
	const [created] = await db
		.insert(corpoNetwork)
		.values({ id: "default" })
		.onConflictDoNothing()
		.returning();
	return (
		created ??
		(await db.query.corpoNetwork.findFirst({
			where: eq(corpoNetwork.id, "default"),
		}))!
	);
};

export interface ParsedCertificate {
	pem: string;
	subject: string;
	issuer: string;
	validTo: string;
	expired: boolean;
}

export const parsePemCertificates = (pem: string | null | undefined) => {
	const blocks =
		(pem ?? "").match(
			/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
		) ?? [];
	const leftover = (pem ?? "")
		.replace(
			/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
			"",
		)
		.trim();
	if (leftover) {
		throw new Error(
			"Only PEM certificates are allowed (-----BEGIN CERTIFICATE----- blocks).",
		);
	}
	return blocks.map((block, index): ParsedCertificate => {
		let cert: X509Certificate;
		try {
			cert = new X509Certificate(block);
		} catch {
			throw new Error(
				`Certificate ${index + 1} is not a valid PEM certificate.`,
			);
		}
		return {
			pem: `${block.trim()}\n`,
			subject: cert.subject.replace(/\n/g, ", "),
			issuer: cert.issuer.replace(/\n/g, ", "),
			validTo: cert.validTo,
			expired: new Date(cert.validTo).getTime() < Date.now(),
		};
	});
};

const PROXY_URL = /^https?:\/\/[^\s/]+(:\d+)?\/?$/i;

export interface UpdateNetworkInput {
	httpProxy: string | null;
	httpsProxy: string | null;
	noProxy: string | null;
	caCertificates: string | null;
	proxyBuilds: boolean;
	proxyContainers: boolean;
	trustCaInContainers: boolean;
}

export const updateNetworkSettings = async (input: UpdateNetworkInput) => {
	for (const value of [input.httpProxy, input.httpsProxy]) {
		if (value && !PROXY_URL.test(value.trim())) {
			throw new Error(
				`"${value}" is not a proxy URL like http://proxy.example.internal:8080`,
			);
		}
	}
	const certificates = parsePemCertificates(input.caCertificates);
	await getNetworkSettings();
	const [updated] = await db
		.update(corpoNetwork)
		.set({
			httpProxy: input.httpProxy?.trim() || null,
			httpsProxy: input.httpsProxy?.trim() || null,
			noProxy: input.noProxy?.trim() || null,
			caCertificates: certificates.map((c) => c.pem).join("") || null,
			proxyBuilds: input.proxyBuilds,
			proxyContainers: input.proxyContainers,
			trustCaInContainers: input.trustCaInContainers,
			updatedAt: new Date(),
		})
		.where(eq(corpoNetwork.id, "default"))
		.returning();
	return updated!;
};

export const caHostDir = () => join(paths().BASE_PATH, "corpo", "ca");

// The panel bind-mounts /etc/dokploy from the host, so the same path works for
// the panel itself and as a bind-mount source for app containers.
export const writeCaFiles = async (settings: NetworkSettings) => {
	const dir = caHostDir();
	const certificates = parsePemCertificates(settings.caCertificates);
	if (certificates.length === 0) {
		await rm(dir, { recursive: true, force: true });
		return null;
	}
	const custom = certificates.map((c) => c.pem).join("");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, CA_CUSTOM_FILE), custom, { mode: 0o644 });
	await writeFile(
		join(dir, CA_BUNDLE_FILE),
		`${rootCertificates.join("\n")}\n${custom}`,
		{ mode: 0o644 },
	);
	return dir;
};

export const PANEL_SERVICE_NAME = "dokploy";

// Proxy and CA variables are read once at process start (Node's
// NODE_USE_ENV_PROXY / NODE_EXTRA_CA_CERTS), so the panel applies them by
// updating its own Swarm service, which restarts it.
export const applyNetworkToPanel = async (settings: NetworkSettings) => {
	const caDir = await writeCaFiles(settings);
	const desired = panelEnv(settings, caDir);
	const args = serviceEnvUpdateArgs(
		desired,
		process.env,
		PANEL_MANAGED_ENV_KEYS,
	);
	if (args.length === 0) {
		return { restarting: false as const, reason: "unchanged" as const };
	}
	if (IS_CLOUD || process.env.NODE_ENV !== "production") {
		return { restarting: false as const, reason: "not-swarm" as const };
	}
	await execFileAsync("docker", [
		"service",
		"update",
		"--detach",
		...args,
		PANEL_SERVICE_NAME,
	]);
	return { restarting: true as const, reason: "changed" as const };
};

export const syncNetworkOnStartup = async () => {
	try {
		const settings = await getNetworkSettings();
		const caDir = await writeCaFiles(settings);
		const pending = serviceEnvUpdateArgs(
			panelEnv(settings, caDir),
			process.env,
			PANEL_MANAGED_ENV_KEYS,
		);
		if (pending.length > 0) {
			console.warn(
				"Corpo: panel proxy/CA environment is out of date; save Settings → Network to apply it.",
			);
		}
	} catch (error) {
		console.error("Corpo: could not sync network settings", error);
	}
};

export const networkEnvFor = async (
	phase: "build" | "runtime",
	serverId: string | null,
) => {
	const settings = await getNetworkSettings();
	const env: Record<string, string> = {};
	if (phase === "build" ? settings.proxyBuilds : settings.proxyContainers) {
		Object.assign(env, proxyEnv(settings));
	}
	const trustCa =
		phase === "runtime" &&
		!serverId &&
		settings.trustCaInContainers &&
		!!settings.caCertificates;
	if (trustCa) {
		const { GIT_SSL_CAINFO: _unused, ...runtimeCaEnv } =
			caEnv(CONTAINER_CA_DIR);
		Object.assign(env, runtimeCaEnv);
	}
	return { env, mountCa: trustCa };
};

export const corpoCaMounts = async (serverId: string | null) => {
	try {
		const { mountCa } = await networkEnvFor("runtime", serverId);
		if (!mountCa) return [];
		return [
			{
				Type: "bind" as const,
				Source: caHostDir(),
				Target: CONTAINER_CA_DIR,
				ReadOnly: true,
			},
		];
	} catch (error) {
		console.error("Corpo: could not resolve CA mount", error);
		return [];
	}
};
