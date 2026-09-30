import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import { parse, stringify } from "yaml";
import { paths } from "../constants";
import type { MainTraefikConfig } from "../utils/traefik/types";
import { corpoGateway } from "./schema";

export type GatewaySettings = typeof corpoGateway.$inferSelect;

export const getGatewaySettings = async (): Promise<GatewaySettings> => {
	const existing = await db.query.corpoGateway.findFirst({
		where: eq(corpoGateway.id, "default"),
	});
	if (existing) {
		return existing;
	}
	const [created] = await db
		.insert(corpoGateway)
		.values({ id: "default" })
		.onConflictDoNothing()
		.returning();
	return (
		created ??
		(await db.query.corpoGateway.findFirst({
			where: eq(corpoGateway.id, "default"),
		}))!
	);
};

export interface UpdateGatewayInput {
	publicHost: string | null;
	publicScheme: "http" | "https";
	pathPrefix: string;
	directHost: string | null;
	trustedProxyIps: string[];
}

export const updateGatewaySettings = async (input: UpdateGatewayInput) => {
	await getGatewaySettings();
	const [updated] = await db
		.update(corpoGateway)
		.set({
			publicHost: input.publicHost?.trim().toLowerCase() || null,
			publicScheme: input.publicScheme,
			pathPrefix: input.pathPrefix.trim(),
			directHost: input.directHost?.trim() || null,
			trustedProxyIps: input.trustedProxyIps
				.map((ip) => ip.trim())
				.filter(Boolean),
			updatedAt: new Date(),
		})
		.where(eq(corpoGateway.id, "default"))
		.returning();
	return updated!;
};

// IIS terminates TLS, so Traefik must trust its X-Forwarded-* headers or apps
// will see http:// and the proxy's address instead of the client's.
export const applyTrustedProxyIps = (trustedIps: string[]) => {
	const { MAIN_TRAEFIK_PATH } = paths();
	const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const config = parse(readFileSync(configPath, "utf8")) as MainTraefikConfig;
	const web = config.entryPoints?.web;
	if (!web) {
		throw new Error("Traefik config has no `web` entrypoint");
	}
	const current = web.forwardedHeaders?.trustedIPs ?? [];
	const unchanged =
		current.length === trustedIps.length &&
		current.every((ip, i) => ip === trustedIps[i]);
	if (unchanged) {
		return false;
	}
	if (trustedIps.length > 0) {
		web.forwardedHeaders = { ...web.forwardedHeaders, trustedIPs: trustedIps };
	} else if (web.forwardedHeaders) {
		delete web.forwardedHeaders.trustedIPs;
		if (Object.keys(web.forwardedHeaders).length === 0) {
			delete web.forwardedHeaders;
		}
	}
	writeFileSync(configPath, stringify(config), "utf8");
	return true;
};
