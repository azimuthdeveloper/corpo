import {
	applyTrustedProxyIps,
	buildPublicUrl,
	createGatewayRoute,
	findApplicationById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	getGatewaySettings,
	getWebServerSettings,
	isGatewayRoute,
	reloadDockerResource,
	updateGatewaySettings,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";

const hostname = z
	.string()
	.trim()
	.regex(/^[a-zA-Z0-9.-]+(:\d+)?$/, "Enter a hostname without scheme or path");

const apiUpdateGateway = z.object({
	publicHost: hostname.nullable(),
	publicScheme: z.enum(["http", "https"]),
	pathPrefix: z
		.string()
		.trim()
		.regex(/^[a-z0-9-]*$/, "Use lowercase letters, numbers and dashes"),
	directHost: hostname.nullable(),
	trustedProxyIps: z.array(
		z
			.string()
			.trim()
			.regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, "Enter an IP address or CIDR"),
	),
});

const apiServiceTarget = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});

const apiCreateGatewayRoute = z
	.object({
		slug: z.string().trim().min(1).max(63),
		port: z.number().int().min(1).max(65535),
		stripPath: z.boolean(),
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		serviceName: z.string().min(1).optional(),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	})
	.refine((v) => !v.composeId || !!v.serviceName, {
		message: "Compose routes need a service name",
	});

const toBadRequest = (error: unknown, fallback: string) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : fallback,
		cause: error,
	});

export const corpoRouter = createTRPCRouter({
	getGateway: protectedProcedure.query(() => getGatewaySettings()),

	updateGateway: adminProcedure
		.input(apiUpdateGateway)
		.mutation(async ({ input, ctx }) => {
			const settings = await updateGatewaySettings(input);
			let traefikReloaded = false;
			try {
				traefikReloaded = applyTrustedProxyIps(settings.trustedProxyIps);
			} catch (error) {
				throw toBadRequest(error, "Could not update the Traefik config");
			}
			if (traefikReloaded) {
				void reloadDockerResource("dokploy-traefik").catch((error) =>
					console.error("Corpo: failed to restart Traefik", error),
				);
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "corpo-gateway",
			});
			return { settings, traefikReloaded };
		}),

	serviceAccess: protectedProcedure
		.input(apiServiceTarget)
		.query(async ({ input, ctx }) => {
			const serviceId = (input.applicationId ?? input.composeId)!;
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["read"],
			});
			const gateway = await getGatewaySettings();
			const webServer = await getWebServerSettings();
			const directHost = gateway.directHost || webServer?.serverIp || null;

			const routes = input.applicationId
				? await findDomainsByApplicationId(input.applicationId)
				: await findDomainsByComposeId(input.composeId!);

			const ports = input.applicationId
				? (await findApplicationById(input.applicationId)).ports
				: [];

			return {
				gateway,
				directHost,
				ports: ports.map((port) => ({
					portId: port.portId,
					publishedPort: port.publishedPort,
					targetPort: port.targetPort,
					protocol: port.protocol,
					url:
						directHost && port.protocol === "tcp"
							? `http://${directHost}:${port.publishedPort}`
							: null,
				})),
				routes: routes.map((route) => {
					const viaGateway = isGatewayRoute(route, gateway);
					const scheme = viaGateway
						? gateway.publicScheme
						: route.https
							? "https"
							: "http";
					return {
						domainId: route.domainId,
						host: route.host,
						path: route.path,
						port: route.port,
						stripPath: route.stripPath,
						enabled: route.enabled,
						serviceName: route.serviceName,
						viaGateway,
						url: buildPublicUrl(scheme, route.host, route.path),
					};
				}),
			};
		}),

	createGatewayRoute: protectedProcedure
		.input(apiCreateGatewayRoute)
		.mutation(async ({ input, ctx }) => {
			const serviceId = (input.applicationId ?? input.composeId)!;
			await checkServicePermissionAndAccess(ctx, serviceId, {
				domain: ["create"],
			});
			try {
				const domain = await createGatewayRoute(input);
				await audit(ctx, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: `${domain.host}${domain.path ?? ""}`,
				});
				return domain;
			} catch (error) {
				throw toBadRequest(error, "Error creating the IIS route");
			}
		}),
});
