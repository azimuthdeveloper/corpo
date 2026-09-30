import { mergeNoProxy } from "@dokploy/server/corpo/network-env";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

interface FormState {
	httpProxy: string;
	httpsProxy: string;
	noProxy: string;
	caCertificates: string;
	proxyBuilds: boolean;
	proxyContainers: boolean;
	trustCaInContainers: boolean;
}

const EMPTY: FormState = {
	httpProxy: "",
	httpsProxy: "",
	noProxy: "",
	caCertificates: "",
	proxyBuilds: true,
	proxyContainers: false,
	trustCaInContainers: true,
};

const Toggle = ({
	id,
	label,
	description,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) => (
	<div className="flex items-start gap-3">
		<Switch id={id} checked={checked} onCheckedChange={onChange} />
		<div className="grid gap-0.5">
			<Label htmlFor={id}>{label}</Label>
			<span className="text-sm text-muted-foreground">{description}</span>
		</div>
	</div>
);

export const NetworkSettings = () => {
	const { data, refetch } = api.corpo.getNetwork.useQuery();
	const { mutateAsync, isPending } = api.corpo.updateNetwork.useMutation();
	const [form, setForm] = useState<FormState>(EMPTY);

	useEffect(() => {
		if (data) {
			const s = data.settings;
			setForm({
				httpProxy: s.httpProxy ?? "",
				httpsProxy: s.httpsProxy ?? "",
				noProxy: s.noProxy ?? "",
				caCertificates: s.caCertificates ?? "",
				proxyBuilds: s.proxyBuilds,
				proxyContainers: s.proxyContainers,
				trustCaInContainers: s.trustCaInContainers,
			});
		}
	}, [data]);

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	const onSave = async () => {
		await mutateAsync({
			httpProxy: form.httpProxy || null,
			httpsProxy: form.httpsProxy || null,
			noProxy: form.noProxy || null,
			caCertificates: form.caCertificates || null,
			proxyBuilds: form.proxyBuilds,
			proxyContainers: form.proxyContainers,
			trustCaInContainers: form.trustCaInContainers,
		})
			.then(async ({ applied }) => {
				await refetch();
				if (applied.restarting) {
					toast.success(
						"Saved. Corpo is restarting to use the new proxy/CA settings; this page will reconnect shortly.",
					);
				} else if (applied.reason === "not-swarm") {
					toast.success(
						"Saved. Restart the panel with these variables to apply them (development mode).",
					);
				} else {
					toast.success("Network settings saved");
				}
			})
			.catch((error) => toast.error(error?.message ?? "Error saving"));
	};

	const hasProxy = !!(form.httpProxy || form.httpsProxy);

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<ShieldCheck className="size-6 text-muted-foreground self-center" />
							Network
						</CardTitle>
						<CardDescription>
							Outbound proxy and internal certificate authority. Used by git
							(cloning and polling), GitHub API calls, builds and, optionally,
							running containers.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-6 py-6 border-t">
						<div className="grid gap-4 md:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="corpo-http-proxy">HTTP proxy</Label>
								<Input
									id="corpo-http-proxy"
									placeholder="http://proxy.example.internal:8080"
									value={form.httpProxy}
									onChange={(e) => set("httpProxy", e.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="corpo-https-proxy">HTTPS proxy</Label>
								<Input
									id="corpo-https-proxy"
									placeholder="Same as HTTP proxy if empty"
									value={form.httpsProxy}
									onChange={(e) => set("httpsProxy", e.target.value)}
								/>
							</div>
							<div className="space-y-1.5 md:col-span-2">
								<Label htmlFor="corpo-no-proxy">No proxy</Label>
								<Input
									id="corpo-no-proxy"
									placeholder=".example.internal,10.0.0.0/8,git.example.internal"
									value={form.noProxy}
									onChange={(e) => set("noProxy", e.target.value)}
								/>
								<p className="text-sm text-muted-foreground">
									Internal hosts that must be reached directly. Corpo always
									adds: <code className="break-all">{mergeNoProxy("")}</code>
								</p>
							</div>
						</div>

						{hasProxy && (
							<AlertBlock type="info">
								Credentials in a proxy URL are visible to anyone who can inspect
								the panel service or containers. Prefer an IP-allow-listed proxy
								account.
							</AlertBlock>
						)}

						<div className="space-y-1.5">
							<Label htmlFor="corpo-ca">Internal CA certificates (PEM)</Label>
							<Textarea
								id="corpo-ca"
								rows={6}
								className="font-mono text-xs"
								placeholder={
									"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
								}
								value={form.caCertificates}
								onChange={(e) => set("caCertificates", e.target.value)}
							/>
							{data && data.certificates.length > 0 && (
								<ul className="space-y-1 text-sm">
									{data.certificates.map((cert) => (
										<li
											key={`${cert.subject}-${cert.validTo}`}
											className="flex flex-wrap items-center gap-2"
										>
											<Badge
												variant={cert.expired ? "destructive" : "secondary"}
											>
												{cert.expired ? "expired" : "valid"}
											</Badge>
											<span className="font-mono text-xs break-all">
												{cert.subject}
											</span>
											<span className="text-muted-foreground">
												until {cert.validTo}
											</span>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className="grid gap-4">
							<Toggle
								id="corpo-proxy-builds"
								label="Use the proxy for builds"
								description="Passes HTTP(S)_PROXY / NO_PROXY as Dockerfile build args and to Nixpacks, Railpack and buildpack builds (npm install, pip, apt…). Nixpacks may bake them into the image."
								checked={form.proxyBuilds}
								onChange={(v) => set("proxyBuilds", v)}
							/>
							<Toggle
								id="corpo-proxy-containers"
								label="Use the proxy in running containers"
								description="Sets the proxy variables on application containers. Add internal service names to No proxy, or container-to-container HTTP calls will go through the proxy."
								checked={form.proxyContainers}
								onChange={(v) => set("proxyContainers", v)}
							/>
							<Toggle
								id="corpo-trust-ca"
								label="Trust the internal CA in running containers"
								description="Mounts the CA read-only at /etc/corpo and sets NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE and CURL_CA_BUNDLE. Applications on this server only; Java needs its own truststore."
								checked={form.trustCaInContainers}
								onChange={(v) => set("trustCaInContainers", v)}
							/>
						</div>

						<div className="flex justify-end">
							<Button onClick={onSave} isLoading={isPending}>
								Save
							</Button>
						</div>
						<p className="text-sm text-muted-foreground">
							Saving a change to the proxy or CA restarts the Corpo panel so it
							picks up the new settings. Running deployments are not affected;
							changes to builds and containers apply on their next deploy.
						</p>

						{data?.dockerDaemonSnippet && (
							<div className="space-y-2 border-t pt-6">
								<h3 className="text-base font-medium">Docker daemon</h3>
								<p className="text-sm text-muted-foreground">
									Image pulls are made by the Docker daemon on the host, which
									Corpo can't configure from inside its container. Run this once
									on the server (the Corpo installer does it for you):
								</p>
								<pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre">
									{data.dockerDaemonSnippet}
								</pre>
								<p className="text-sm text-muted-foreground">
									If a private registry uses the internal CA, also copy the CA
									to{" "}
									<code>/etc/docker/certs.d/&lt;registry-host&gt;/ca.crt</code>.
								</p>
							</div>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
