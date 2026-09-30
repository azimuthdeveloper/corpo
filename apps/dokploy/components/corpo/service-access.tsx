import { slugToRoutePath } from "@dokploy/server/corpo/routing";
import { ExternalLink, Route } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	id: string;
	type: "application" | "compose";
}

export const ServiceAccess = ({ id, type }: Props) => {
	const target =
		type === "application" ? { applicationId: id } : { composeId: id };
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canCreate = permissions?.domain.create ?? false;
	const { data } = api.corpo.serviceAccess.useQuery(target, { enabled: !!id });
	const { data: composeServices } = api.compose.loadServices.useQuery(
		{ composeId: id, type: "cache" },
		{ enabled: type === "compose" && !!id, retry: false },
	);
	const { mutateAsync, isPending } = api.corpo.createGatewayRoute.useMutation();

	const [slug, setSlug] = useState("");
	const [port, setPort] = useState("3000");
	const [stripPath, setStripPath] = useState(false);
	const [serviceName, setServiceName] = useState("");

	if (!data) {
		return null;
	}

	const { gateway, ports, routes } = data;
	const previewPath = slug ? slugToRoutePath(gateway.pathPrefix, slug) : null;

	const onCreate = async () => {
		await mutateAsync({
			...target,
			slug,
			port: Number(port),
			stripPath,
			serviceName: type === "compose" ? serviceName : undefined,
		})
			.then(async () => {
				toast.success("IIS route added");
				setSlug("");
				await Promise.all([
					utils.corpo.serviceAccess.invalidate(target),
					type === "application"
						? utils.domain.byApplicationId.invalidate({ applicationId: id })
						: utils.domain.byComposeId.invalidate({ composeId: id }),
				]);
			})
			.catch((error) => toast.error(error?.message ?? "Error adding route"));
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex flex-row gap-2">
					<Route className="size-6 text-muted-foreground self-center" />
					Access
				</CardTitle>
				<CardDescription>
					Where people reach this service. Apps get <code>CORPO_BASE_PATH</code>{" "}
					and <code>CORPO_PUBLIC_URL</code> at build and run time for their
					primary route
					{type === "compose" ? " (applications only)" : ""}.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{(routes.length > 0 || ports.length > 0) && (
					<div className="space-y-2">
						{routes.map((route) => (
							<div
								key={route.domainId}
								className="flex flex-wrap items-center gap-2 text-sm"
							>
								<Badge variant={route.viaGateway ? "default" : "secondary"}>
									{route.viaGateway ? "IIS" : "Domain"}
								</Badge>
								<a
									href={route.url}
									target="_blank"
									rel="noreferrer"
									className="font-mono hover:underline inline-flex items-center gap-1"
								>
									{route.url}
									<ExternalLink className="size-3" />
								</a>
								<span className="text-muted-foreground">
									→ {route.serviceName ? `${route.serviceName}:` : "port "}
									{route.port ?? "?"}
									{route.stripPath ? " · strip path" : ""}
									{route.enabled ? "" : " · disabled"}
								</span>
							</div>
						))}
						{ports.map((port) => (
							<div
								key={port.portId}
								className="flex flex-wrap items-center gap-2 text-sm"
							>
								<Badge variant="outline">Port</Badge>
								{port.url ? (
									<a
										href={port.url}
										target="_blank"
										rel="noreferrer"
										className="font-mono hover:underline inline-flex items-center gap-1"
									>
										{port.url}
										<ExternalLink className="size-3" />
									</a>
								) : (
									<span className="font-mono">
										{port.publishedPort}/{port.protocol}
									</span>
								)}
								<span className="text-muted-foreground">
									→ container port {port.targetPort}
								</span>
							</div>
						))}
					</div>
				)}
				{routes.length === 0 && ports.length === 0 && (
					<p className="text-sm text-muted-foreground">
						Not reachable yet. Add an IIS route below
						{type === "application"
							? ", or publish a port in Advanced → Ports"
							: ""}
						.
					</p>
				)}

				{canCreate && (
					<div className="space-y-3 border-t pt-4">
						<h3 className="text-sm font-medium">Add IIS route</h3>
						{!gateway.publicHost ? (
							<AlertBlock type="info">
								Set the IIS public host in{" "}
								<Link
									href="/dashboard/settings/gateway"
									className="text-primary"
								>
									Settings → Gateway
								</Link>{" "}
								first.
							</AlertBlock>
						) : (
							<>
								<div className="grid gap-3 md:grid-cols-3">
									<div className="space-y-1.5">
										<Label htmlFor="corpo-route-slug">Route name</Label>
										<Input
											id="corpo-route-slug"
											placeholder="myapp"
											value={slug}
											onChange={(e) => setSlug(e.target.value)}
										/>
									</div>
									{type === "compose" && (
										<div className="space-y-1.5">
											<Label>Service</Label>
											<Select
												value={serviceName}
												onValueChange={setServiceName}
											>
												<SelectTrigger>
													<SelectValue placeholder="Select a service" />
												</SelectTrigger>
												<SelectContent>
													{(composeServices ?? []).map((service) => (
														<SelectItem key={service} value={service}>
															{service}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									)}
									<div className="space-y-1.5">
										<Label htmlFor="corpo-route-port">Container port</Label>
										<Input
											id="corpo-route-port"
											type="number"
											min={1}
											max={65535}
											value={port}
											onChange={(e) => setPort(e.target.value)}
										/>
									</div>
								</div>
								<div className="flex items-start gap-3">
									<Switch
										id="corpo-route-strip"
										checked={stripPath}
										onCheckedChange={setStripPath}
									/>
									<Label
										htmlFor="corpo-route-strip"
										className="block font-normal text-muted-foreground leading-snug"
									>
										Strip the path before forwarding. Turn this on for apps that
										only work at <code>/</code>; leave it off for apps that
										serve under <code>CORPO_BASE_PATH</code> themselves (Next.js
										basePath, Vite base, ASP.NET UsePathBase…).
									</Label>
								</div>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="text-sm text-muted-foreground font-mono">
										{previewPath
											? `${gateway.publicScheme}://${gateway.publicHost}${previewPath}`
											: ""}
									</span>
									<Button
										onClick={onCreate}
										isLoading={isPending}
										disabled={
											!previewPath ||
											!Number(port) ||
											(type === "compose" && !serviceName)
										}
									>
										Add route
									</Button>
								</div>
							</>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
