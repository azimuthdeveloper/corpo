import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { api } from "@/utils/api";

interface Props {
	id: string;
	type: "application" | "compose";
}

const formatTime = (value: Date | string | null) =>
	value ? new Date(value).toLocaleString() : "never";

export const ServiceAutoDeploy = ({ id, type }: Props) => {
	const target =
		type === "application" ? { applicationId: id } : { composeId: id };
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canEdit = permissions?.service.create ?? false;
	const { data, refetch } = api.corpo.serviceGit.useQuery(target, {
		enabled: !!id,
		refetchInterval: 30_000,
	});
	const polling = api.corpo.updateServiceGitPolling.useMutation();
	const token = api.corpo.updateServiceGitToken.useMutation();
	const pollNow = api.corpo.pollServiceGitNow.useMutation();

	const [interval, setIntervalValue] = useState("60");
	const [username, setUsername] = useState("");
	const [tokenValue, setTokenValue] = useState("");

	useEffect(() => {
		if (data) {
			setIntervalValue(String(data.pollIntervalSeconds));
			setUsername(data.httpsUsername ?? "");
		}
	}, [data]);

	if (!data) {
		return null;
	}

	const refresh = () =>
		Promise.all([refetch(), utils.corpo.serviceGit.invalidate(target)]);

	const savePolling = async (pollEnabled: boolean) => {
		await polling
			.mutateAsync({
				...target,
				pollEnabled,
				pollIntervalSeconds: Math.max(30, Number(interval) || 60),
			})
			.then(async ({ error }) => {
				await refresh();
				if (error) {
					toast.error(`Saved, but the repository check failed: ${error}`);
				} else {
					toast.success(
						pollEnabled ? "Polling for new commits" : "Polling saved",
					);
				}
			})
			.catch((error) => toast.error(error?.message ?? "Error saving"));
	};

	const saveToken = async (clear: boolean) => {
		await token
			.mutateAsync({
				...target,
				httpsUsername: clear ? null : username || null,
				httpsToken: clear ? null : tokenValue,
			})
			.then(async () => {
				setTokenValue("");
				await refresh();
				toast.success(clear ? "Token removed" : "Token saved");
			})
			.catch((error) => toast.error(error?.message ?? "Error saving token"));
	};

	const checkNow = async () => {
		await pollNow
			.mutateAsync(target)
			.then(async (result) => {
				await refresh();
				if (result.error) {
					toast.error(result.error);
				} else if (result.decision === "deploy") {
					toast.success(
						`New commit ${result.sha?.slice(0, 7)} found, deployment queued`,
					);
				} else {
					toast.success(`Up to date at ${result.sha?.slice(0, 7)}`);
				}
			})
			.catch((error) => toast.error(error?.message ?? "Check failed"));
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex flex-row gap-2">
					<GitCommitHorizontal className="size-6 text-muted-foreground self-center" />
					Auto-deploy by polling
				</CardTitle>
				<CardDescription>
					Corpo checks the branch for new commits and deploys when it changes.
					Use this when the git host (GitHub.com, Azure DevOps) can't send
					webhooks into the network. Watch paths are not applied to polled
					deployments.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{!data.pollable ? (
					<AlertBlock type="info">
						Polling works with GitHub and Git sources. This service uses{" "}
						<code>{data.sourceType}</code>.
					</AlertBlock>
				) : (
					<>
						<div className="flex flex-wrap items-end gap-4">
							<div className="flex items-center gap-3">
								<Switch
									id="corpo-poll-enabled"
									checked={data.pollEnabled}
									disabled={!canEdit || polling.isPending}
									onCheckedChange={(checked) => savePolling(checked)}
								/>
								<Label htmlFor="corpo-poll-enabled">Poll for new commits</Label>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="corpo-poll-interval">Every (seconds)</Label>
								<Input
									id="corpo-poll-interval"
									type="number"
									min={30}
									className="w-32"
									value={interval}
									disabled={!canEdit}
									onChange={(e) => setIntervalValue(e.target.value)}
								/>
							</div>
							{canEdit && Number(interval) !== data.pollIntervalSeconds && (
								<Button
									variant="secondary"
									isLoading={polling.isPending}
									onClick={() => savePolling(data.pollEnabled)}
								>
									Save interval
								</Button>
							)}
							<Button
								variant="outline"
								isLoading={pollNow.isPending}
								onClick={checkNow}
							>
								<RefreshCw className="size-4" />
								Check now
							</Button>
						</div>
						<div className="grid gap-1 text-sm text-muted-foreground">
							<span>
								Last checked: {formatTime(data.lastPolledAt)}
								{data.lastSeenSha && (
									<>
										{" · "}at{" "}
										<code className="font-mono">
											{data.lastSeenSha.slice(0, 7)}
										</code>
									</>
								)}
							</span>
							{data.pollEnabled && (
								<span>Next check: {formatTime(data.nextPollAt)}</span>
							)}
						</div>
						{data.lastPollError && (
							<AlertBlock type="error">{data.lastPollError}</AlertBlock>
						)}
					</>
				)}

				{data.httpsRepository && (
					<div className="space-y-3 border-t pt-4">
						<h3 className="text-sm font-medium">HTTPS credentials</h3>
						<p className="text-sm text-muted-foreground">
							For private repositories over HTTPS, such as Azure DevOps with a
							personal access token (Code: Read scope). The token is sent as an
							HTTP header, never put in the URL or logs.{" "}
							{data.hasHttpsToken ? "A token is saved." : "No token is saved."}
						</p>
						{canEdit && (
							<div className="flex flex-wrap items-end gap-3">
								<div className="space-y-1.5">
									<Label htmlFor="corpo-git-user">Username (optional)</Label>
									<Input
										id="corpo-git-user"
										placeholder="pat"
										value={username}
										onChange={(e) => setUsername(e.target.value)}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="corpo-git-token">Token</Label>
									<Input
										id="corpo-git-token"
										type="password"
										autoComplete="off"
										placeholder={
											data.hasHttpsToken ? "•••••••• (unchanged)" : ""
										}
										value={tokenValue}
										onChange={(e) => setTokenValue(e.target.value)}
									/>
								</div>
								<Button
									isLoading={token.isPending}
									disabled={!tokenValue}
									onClick={() => saveToken(false)}
								>
									Save token
								</Button>
								{data.hasHttpsToken && (
									<Button
										variant="outline"
										isLoading={token.isPending}
										onClick={() => saveToken(true)}
									>
										Remove
									</Button>
								)}
							</div>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
