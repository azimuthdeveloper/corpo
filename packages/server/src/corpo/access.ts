import { db } from "@dokploy/server/db";
import { domains } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { type GatewaySettings, getGatewaySettings } from "./gateway";
import { buildPublicUrl, normalizeRoutePath } from "./routing";

type RouteDomain = Pick<
	typeof domains.$inferSelect,
	"host" | "path" | "https" | "enabled"
>;

export const isGatewayRoute = (
	domain: Pick<RouteDomain, "host">,
	gateway: Pick<GatewaySettings, "publicHost">,
) =>
	!!gateway.publicHost &&
	domain.host.toLowerCase() === gateway.publicHost.toLowerCase();

export const resolvePrimaryRoute = (
	routes: RouteDomain[],
	gateway: Pick<GatewaySettings, "publicHost" | "publicScheme">,
) => {
	const enabled = routes.filter((route) => route.enabled);
	const gatewayRoute = enabled.find((route) => isGatewayRoute(route, gateway));
	const route = gatewayRoute ?? enabled[0];
	if (!route) {
		return null;
	}
	const scheme = gatewayRoute
		? gateway.publicScheme
		: route.https
			? "https"
			: "http";
	return {
		basePath: normalizeRoutePath(route.path) ?? "",
		publicUrl: buildPublicUrl(scheme, route.host, route.path),
	};
};

// Earlier dotenv entries lose to later ones, so these go first and any value
// the user sets explicitly still wins.
export const prependEnv = (
	env: string | null,
	vars: Record<string, string>,
) => {
	const lines = Object.entries(vars).map(([key, value]) => `${key}=${value}`);
	return [...lines, env ?? ""].join("\n");
};

export const corpoRouteEnv = async (applicationId: string) => {
	const [routes, gateway] = await Promise.all([
		db.query.domains.findMany({
			where: eq(domains.applicationId, applicationId),
			columns: { host: true, path: true, https: true, enabled: true },
		}),
		getGatewaySettings(),
	]);
	const primary = resolvePrimaryRoute(routes, gateway);
	if (!primary) {
		return null;
	}
	return {
		CORPO_BASE_PATH: primary.basePath,
		CORPO_PUBLIC_URL: primary.publicUrl,
	};
};

// Next.js basePath, Vite base and similar are read at build time, so the vars
// go into build args as well as the runtime env.
export const withCorpoEnv = async <
	T extends {
		applicationId: string;
		env: string | null;
		buildArgs: string | null;
	},
>(
	application: T,
): Promise<T> => {
	let vars: Awaited<ReturnType<typeof corpoRouteEnv>> = null;
	try {
		vars = await corpoRouteEnv(application.applicationId);
	} catch (error) {
		console.error("Corpo: could not resolve route env vars", error);
	}
	if (!vars) {
		return application;
	}
	return {
		...application,
		env: prependEnv(application.env, vars),
		buildArgs: prependEnv(application.buildArgs, vars),
	};
};
