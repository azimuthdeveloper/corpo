import { db } from "@dokploy/server/db";
import { domains } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { createDomain } from "../services/domain";
import { getGatewaySettings } from "./gateway";
import { slugToRoutePath } from "./routing";

export interface CreateGatewayRouteInput {
	slug: string;
	port: number;
	stripPath: boolean;
	applicationId?: string;
	composeId?: string;
	serviceName?: string;
}

export const createGatewayRoute = async (input: CreateGatewayRouteInput) => {
	const gateway = await getGatewaySettings();
	if (!gateway.publicHost) {
		throw new Error(
			"Set the IIS public host in Settings → Gateway before adding IIS routes.",
		);
	}
	const path = slugToRoutePath(gateway.pathPrefix, input.slug);
	if (!path) {
		throw new Error("The route name must contain letters or numbers.");
	}
	const clash = await db.query.domains.findFirst({
		where: and(eq(domains.host, gateway.publicHost), eq(domains.path, path)),
		columns: { domainId: true },
	});
	if (clash) {
		throw new Error(`${path} is already used by another service.`);
	}
	return createDomain({
		host: gateway.publicHost,
		path,
		port: input.port,
		https: false,
		certificateType: "none",
		stripPath: input.stripPath,
		internalPath: "/",
		domainType: input.composeId ? "compose" : "application",
		applicationId: input.applicationId,
		composeId: input.composeId,
		serviceName: input.serviceName,
	});
};
