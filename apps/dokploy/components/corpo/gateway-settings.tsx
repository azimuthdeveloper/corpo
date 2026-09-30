import {
	buildIisWebConfig,
	IIS_SERVER_COMMANDS,
} from "@dokploy/server/corpo/iis";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Network } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const HOSTNAME = /^[a-zA-Z0-9.-]+(:\d+)?$/;
const IP_OR_CIDR = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

const gatewaySchema = z.object({
	publicHost: z
		.string()
		.trim()
		.refine((v) => v === "" || HOSTNAME.test(v), {
			message: "Hostname only, e.g. iis.example.internal",
		}),
	publicScheme: z.enum(["http", "https"]),
	pathPrefix: z
		.string()
		.trim()
		.regex(/^[a-z0-9-]*$/, "Use lowercase letters, numbers and dashes"),
	directHost: z
		.string()
		.trim()
		.refine((v) => v === "" || HOSTNAME.test(v), {
			message: "Hostname or IP only, e.g. corpo01.internal",
		}),
	trustedProxyIps: z
		.string()
		.refine((v) => splitList(v).every((entry) => IP_OR_CIDR.test(entry)), {
			message: "One IP address or CIDR per line",
		}),
});

type GatewayForm = z.infer<typeof gatewaySchema>;

function splitList(value: string) {
	return value
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export const GatewaySettings = () => {
	const { data, refetch } = api.corpo.getGateway.useQuery();
	const { mutateAsync, isPending } = api.corpo.updateGateway.useMutation();

	const form = useForm<GatewayForm>({
		defaultValues: {
			publicHost: "",
			publicScheme: "https",
			pathPrefix: "cor-",
			directHost: "",
			trustedProxyIps: "",
		},
		resolver: zodResolver(gatewaySchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				publicHost: data.publicHost ?? "",
				publicScheme: data.publicScheme === "http" ? "http" : "https",
				pathPrefix: data.pathPrefix,
				directHost: data.directHost ?? "",
				trustedProxyIps: data.trustedProxyIps.join("\n"),
			});
		}
	}, [data, form]);

	const onSubmit = async (values: GatewayForm) => {
		await mutateAsync({
			publicHost: values.publicHost || null,
			publicScheme: values.publicScheme,
			pathPrefix: values.pathPrefix,
			directHost: values.directHost || null,
			trustedProxyIps: splitList(values.trustedProxyIps),
		})
			.then(async ({ traefikReloaded }) => {
				await refetch();
				toast.success(
					traefikReloaded
						? "Gateway saved. Traefik is restarting to trust the new proxy IPs."
						: "Gateway saved",
				);
			})
			.catch((error) => {
				toast.error(error?.message ?? "Error saving the gateway settings");
			});
	};

	const watched = form.watch();
	const backendHost = watched.directHost || "<corpo-server>";

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<Network className="size-6 text-muted-foreground self-center" />
							Gateway
						</CardTitle>
						<CardDescription>
							How people reach apps hosted on Corpo: through the IIS reverse
							proxy (which terminates SSL), or directly by port on this server.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 py-6 border-t">
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								className="grid w-full gap-4 md:grid-cols-2"
							>
								<FormField
									control={form.control}
									name="publicHost"
									render={({ field }) => (
										<FormItem>
											<FormLabel>IIS public host</FormLabel>
											<FormControl>
												<Input
													placeholder="iis.example.internal"
													{...field}
												/>
											</FormControl>
											<FormDescription>
												The host users type in the browser. IIS routes are
												created on this host.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="publicScheme"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Public scheme</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													<SelectItem value="https">
														https (IIS terminates SSL)
													</SelectItem>
													<SelectItem value="http">http</SelectItem>
												</SelectContent>
											</Select>
											<FormDescription>
												Used to build public URLs and passed to apps as
												X-Forwarded-Proto.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="pathPrefix"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Route prefix</FormLabel>
											<FormControl>
												<Input placeholder="cor-" {...field} />
											</FormControl>
											<FormDescription>
												Every IIS route starts with this, so a single IIS rule
												covers all Corpo apps (e.g. /cor-myapp).
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="directHost"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Corpo server address</FormLabel>
											<FormControl>
												<Input placeholder="corpo01.internal" {...field} />
											</FormControl>
											<FormDescription>
												Hostname or IP of this server on the network. Used for
												direct port URLs and as the IIS rewrite target.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="trustedProxyIps"
									render={({ field }) => (
										<FormItem className="md:col-span-2">
											<FormLabel>Trusted proxy IPs</FormLabel>
											<FormControl>
												<Textarea
													placeholder={"10.1.2.3\n10.1.2.0/24"}
													rows={3}
													{...field}
												/>
											</FormControl>
											<FormDescription>
												IIS server addresses. Traefik only trusts
												X-Forwarded-Proto / X-Forwarded-For from these, so apps
												see https and the real client IP. Saving a change
												restarts Traefik.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="flex justify-end md:col-span-2">
									<Button type="submit" isLoading={isPending}>
										Save
									</Button>
								</div>
							</form>
						</Form>

						<div className="space-y-3 border-t pt-6">
							<h3 className="text-base font-medium">IIS configuration</h3>
							<p className="text-sm text-muted-foreground">
								Install URL Rewrite and Application Request Routing (ARR) on the
								IIS server and enable the WebSocket Protocol feature. Then run
								these once from an elevated prompt:
							</p>
							<pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre">
								{IIS_SERVER_COMMANDS.join("\n")}
							</pre>
							<p className="text-sm text-muted-foreground">
								Add this rule to the web.config of the{" "}
								<code>{watched.publicHost || "IIS"}</code> site. It forwards
								every <code>/{watched.pathPrefix}*</code> request to Corpo, so
								new apps never need an IIS change.
							</p>
							{!watched.directHost && (
								<AlertBlock type="warning">
									Set the Corpo server address above to fill in the rewrite
									target.
								</AlertBlock>
							)}
							<pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre">
								{buildIisWebConfig({
									pathPrefix: watched.pathPrefix,
									backendHost,
									publicScheme: watched.publicScheme,
								})}
							</pre>
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
