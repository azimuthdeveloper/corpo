import {
	applyNetworkToPanel,
	applyTrustedProxyIps,
	buildPublicUrl,
	createGatewayRoute,
	dockerDaemonProxySnippet,
	findApplicationById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	getGatewaySettings,
	getNetworkSettings,
	getServiceGitRow,
	getServiceGitSettings,
	getWebServerSettings,
	isGatewayRoute,
	MIN_POLL_INTERVAL_SECONDS,
	POLLABLE_SOURCES,
	parsePemCertificates,
	pollServiceGit,
	reloadDockerResource,
	type ServiceTarget,
	updateGatewaySettings,
	updateNetworkSettings,
	updateServiceGitPolling,
	updateServiceGitToken,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { enqueuePolledDeployment } from "@/server/corpo/poll-deploy";

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

const toServiceTarget = (input: {
	applicationId?: string;
	composeId?: string;
}): ServiceTarget =>
	input.applicationId
		? { applicationId: input.applicationId }
		: { composeId: input.composeId! };

const loadGitSource = async (target: ServiceTarget) => {
	const columns = {
		sourceType: true,
		customGitUrl: true,
		autoDeploy: true,
	} as const;
	const service = target.applicationId
		? await db.query.applications.findFirst({
				where: eq(applications.applicationId, target.applicationId),
				columns,
			})
		: await db.query.compose.findFirst({
				where: eq(compose.composeId, target.composeId!),
				columns,
			});
	if (!service) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
	}
	return service;
};

const apiServiceGitPolling = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		pollEnabled: z.boolean(),
		pollIntervalSeconds: z
			.number()
			.int()
			.min(MIN_POLL_INTERVAL_SECONDS)
			.max(24 * 60 * 60),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});

const apiServiceGitToken = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		httpsUsername: z.string().trim().max(200).nullable(),
		httpsToken: z.string().min(1).max(4000).nullable(),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});

const apiUpdateNetwork = z.object({
	httpProxy: z.string().trim().max(500).nullable(),
	httpsProxy: z.string().trim().max(500).nullable(),
	noProxy: z.string().trim().max(4000).nullable(),
	caCertificates: z.string().max(200_000).nullable(),
	proxyBuilds: z.boolean(),
	proxyContainers: z.boolean(),
	trustCaInContainers: z.boolean(),
});

const describeNetwork = (
	settings: Awaited<ReturnType<typeof getNetworkSettings>>,
) => {
	let certificates: ReturnType<typeof parsePemCertificates> = [];
	try {
		certificates = parsePemCertificates(settings.caCertificates);
	} catch {}
	return {
		settings,
		certificates: certificates.map(({ pem: _pem, ...info }) => info),
		dockerDaemonSnippet: dockerDaemonProxySnippet(settings),
	};
};

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

	serviceGit: protectedProcedure
		.input(apiServiceTarget)
		.query(async ({ input, ctx }) => {
			const target = toServiceTarget(input);
			await checkServicePermissionAndAccess(
				ctx,
				(input.applicationId ?? input.composeId)!,
				{ service: ["read"] },
			);
			const source = await loadGitSource(target);
			return {
				...(await getServiceGitSettings(target)),
				sourceType: source.sourceType,
				pollable: (POLLABLE_SOURCES as readonly string[]).includes(
					source.sourceType,
				),
				httpsRepository:
					source.sourceType === "git" &&
					/^https?:\/\//i.test(source.customGitUrl ?? ""),
			};
		}),

	updateServiceGitPolling: protectedProcedure
		.input(apiServiceGitPolling)
		.mutation(async ({ input, ctx }) => {
			const target = toServiceTarget(input);
			await checkServicePermissionAndAccess(
				ctx,
				(input.applicationId ?? input.composeId)!,
				{ service: ["create"] },
			);
			const source = await loadGitSource(target);
			if (
				input.pollEnabled &&
				!(POLLABLE_SOURCES as readonly string[]).includes(source.sourceType)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Polling supports GitHub and Git sources, not "${source.sourceType}".`,
				});
			}
			const { row, turningOn } = await updateServiceGitPolling(target, input);
			const result = turningOn
				? await pollServiceGit(row, enqueuePolledDeployment, { deploy: false })
				: null;
			return { error: result?.row?.lastPollError ?? null };
		}),

	updateServiceGitToken: protectedProcedure
		.input(apiServiceGitToken)
		.mutation(async ({ input, ctx }) => {
			const target = toServiceTarget(input);
			await checkServicePermissionAndAccess(
				ctx,
				(input.applicationId ?? input.composeId)!,
				{ service: ["create"] },
			);
			await updateServiceGitToken(target, input);
			await audit(ctx, {
				action: "update",
				resourceType: "service",
				resourceId: (input.applicationId ?? input.composeId)!,
				resourceName: "git-https-token",
			});
			return true;
		}),

	pollServiceGitNow: protectedProcedure
		.input(apiServiceTarget)
		.mutation(async ({ input, ctx }) => {
			const target = toServiceTarget(input);
			await checkServicePermissionAndAccess(
				ctx,
				(input.applicationId ?? input.composeId)!,
				{ deployment: ["create"] },
			);
			const row = await getServiceGitRow(target);
			const result = await pollServiceGit(row, enqueuePolledDeployment, {
				deploy: row.pollEnabled && !!row.lastSeenSha,
			});
			return {
				decision: result.decision,
				sha: result.sha,
				error: result.row?.lastPollError ?? null,
			};
		}),

	getNetwork: adminProcedure.query(async () =>
		describeNetwork(await getNetworkSettings()),
	),

	updateNetwork: adminProcedure
		.input(apiUpdateNetwork)
		.mutation(async ({ input, ctx }) => {
			let settings: Awaited<ReturnType<typeof updateNetworkSettings>>;
			try {
				settings = await updateNetworkSettings(input);
			} catch (error) {
				throw toBadRequest(error, "Invalid network settings");
			}
			let applied: Awaited<ReturnType<typeof applyNetworkToPanel>>;
			try {
				applied = await applyNetworkToPanel(settings);
			} catch (error) {
				throw toBadRequest(
					error,
					"Saved, but the panel could not be updated with the new settings",
				);
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "corpo-network",
			});
			return { ...describeNetwork(settings), applied };
		}),
});
