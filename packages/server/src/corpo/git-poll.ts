import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { findGithubById } from "../services/github";
import { findSSHKeyById } from "../services/ssh-key";
import {
	authGithub,
	getGithubToken,
	normalizeGithubUrl,
} from "../utils/providers/github";
import { gitAuthEnv, isHttpGitUrl, type ServiceTarget } from "./git-auth";
import { corpoServiceGit } from "./schema";

const execFileAsync = promisify(execFile);

export const MIN_POLL_INTERVAL_SECONDS = 30;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const LS_REMOTE_TIMEOUT_MS = 30_000;

export type PollDecision = "baseline" | "unchanged" | "deploy";

export const decidePoll = (
	lastSeenSha: string | null,
	headSha: string,
): PollDecision => {
	if (!lastSeenSha) return "baseline";
	return lastSeenSha === headSha ? "unchanged" : "deploy";
};

export const computeNextPollAt = (
	now: Date,
	intervalSeconds: number,
	consecutiveFailures: number,
) => {
	const base = Math.max(intervalSeconds, MIN_POLL_INTERVAL_SECONDS) * 1000;
	const backoff = base * 2 ** Math.min(consecutiveFailures, 6);
	return new Date(
		now.getTime() + Math.min(backoff, Math.max(base, MAX_BACKOFF_MS)),
	);
};

// git and our own URLs can echo credentials back in error text; never let a
// token reach the database or the UI.
export const redactSecrets = (message: string, secrets: string[]) => {
	let redacted = message.replace(/\/\/[^/@\s]+@/g, "//***@");
	for (const secret of secrets) {
		if (secret) redacted = redacted.split(secret).join("***");
	}
	return redacted.trim().slice(0, 1000);
};

export const parseLsRemote = (stdout: string, branch: string) => {
	const ref = `refs/heads/${branch}`;
	for (const line of stdout.split("\n")) {
		const [sha, name] = line.trim().split(/\s+/);
		if (name === ref && sha && /^[0-9a-f]{40,64}$/i.test(sha)) {
			return sha;
		}
	}
	return null;
};

export interface GitSource {
	url: string;
	branch: string;
	env: Record<string, string>;
	secrets: string[];
	cleanup: () => Promise<void>;
}

type PollableService = {
	sourceType: string;
	owner: string | null;
	repository: string | null;
	branch: string | null;
	githubId: string | null;
	customGitUrl: string | null;
	customGitBranch: string | null;
	customGitSSHKeyId: string | null;
	serverId: string | null;
	appName: string;
};

const noop = async () => {};

export const POLLABLE_SOURCES = ["github", "git"] as const;

const resolveGitSource = async (
	service: PollableService,
	credentials: {
		httpsUsername: string | null;
		httpsToken: string | null;
	} | null,
): Promise<GitSource> => {
	if (service.sourceType === "github") {
		if (
			!service.githubId ||
			!service.owner ||
			!service.repository ||
			!service.branch
		) {
			throw new Error("The GitHub provider, repository or branch is not set.");
		}
		const provider = await findGithubById(service.githubId);
		const token = await getGithubToken(authGithub(provider));
		const base = new URL(normalizeGithubUrl(provider.githubUrl));
		return {
			url: `${base.protocol}//x-access-token:${token}@${base.host}/${service.owner}/${service.repository}.git`,
			branch: service.branch,
			env: {},
			secrets: [token],
			cleanup: noop,
		};
	}

	if (service.sourceType === "git") {
		const url = service.customGitUrl;
		const branch = service.customGitBranch;
		if (!url || !branch) {
			throw new Error("The repository URL or branch is not set.");
		}
		if (isHttpGitUrl(url)) {
			const token = credentials?.httpsToken;
			return {
				url,
				branch,
				env: token ? gitAuthEnv(credentials?.httpsUsername ?? null, token) : {},
				secrets: token ? [token] : [],
				cleanup: noop,
			};
		}
		if (!service.customGitSSHKeyId) {
			throw new Error("SSH repositories need an SSH key.");
		}
		const sshKey = await findSSHKeyById(service.customGitSSHKeyId);
		const dir = await mkdtemp(join(tmpdir(), "corpo-poll-"));
		const keyPath = join(dir, "id");
		await writeFile(keyPath, `${sshKey.privateKey.trim()}\n`, { mode: 0o600 });
		return {
			url,
			branch,
			env: {
				GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o UserKnownHostsFile=${join(dir, "known_hosts")} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
			},
			secrets: [],
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	}

	throw new Error(
		`Polling supports GitHub and Git sources; this service uses "${service.sourceType}".`,
	);
};

export const lsRemoteHead = async (source: GitSource) => {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["ls-remote", "--heads", source.url, `refs/heads/${source.branch}`],
			{
				timeout: LS_REMOTE_TIMEOUT_MS,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...source.env },
			},
		);
		const sha = parseLsRemote(stdout, source.branch);
		if (!sha) {
			throw new Error(`Branch "${source.branch}" was not found on the remote.`);
		}
		return sha;
	} catch (error) {
		const detail =
			error && typeof error === "object" && "stderr" in error
				? String((error as { stderr: unknown }).stderr || "")
				: "";
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redactSecrets(detail || message, source.secrets));
	}
};

const loadService = async (target: ServiceTarget) => {
	const columns = {
		sourceType: true,
		owner: true,
		repository: true,
		branch: true,
		githubId: true,
		customGitUrl: true,
		customGitBranch: true,
		customGitSSHKeyId: true,
		serverId: true,
		appName: true,
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
		throw new Error("Service not found.");
	}
	return service as PollableService;
};

export const fetchRemoteHead = async (
	target: ServiceTarget,
	credentials: {
		httpsUsername: string | null;
		httpsToken: string | null;
	} | null,
) => {
	const service = await loadService(target);
	const source = await resolveGitSource(service, credentials);
	try {
		return { sha: await lsRemoteHead(source), service };
	} finally {
		await source.cleanup();
	}
};

export interface PollDeploymentJob {
	target: ServiceTarget;
	sha: string;
	serverId: string | null;
}

export type EnqueueDeployment = (job: PollDeploymentJob) => Promise<unknown>;

type ServiceGitRow = typeof corpoServiceGit.$inferSelect;

const rowTarget = (row: ServiceGitRow): ServiceTarget =>
	row.applicationId
		? { applicationId: row.applicationId }
		: { composeId: row.composeId! };

export const pollServiceGit = async (
	row: ServiceGitRow,
	enqueue: EnqueueDeployment,
	{ deploy = true }: { deploy?: boolean } = {},
) => {
	const now = new Date();
	try {
		const { sha, service } = await fetchRemoteHead(rowTarget(row), row);
		const decision = deploy ? decidePoll(row.lastSeenSha, sha) : "baseline";
		if (decision === "deploy") {
			await enqueue({
				target: rowTarget(row),
				sha,
				serverId: service.serverId,
			});
		}
		const [updated] = await db
			.update(corpoServiceGit)
			.set({
				lastPolledAt: now,
				nextPollAt: computeNextPollAt(now, row.pollIntervalSeconds, 0),
				lastSeenSha: sha,
				lastPollError: null,
				consecutiveFailures: 0,
			})
			.where(eq(corpoServiceGit.id, row.id))
			.returning();
		return { decision, sha, row: updated };
	} catch (error) {
		const failures = row.consecutiveFailures + 1;
		const [updated] = await db
			.update(corpoServiceGit)
			.set({
				lastPolledAt: now,
				nextPollAt: computeNextPollAt(now, row.pollIntervalSeconds, failures),
				lastPollError: error instanceof Error ? error.message : String(error),
				consecutiveFailures: failures,
			})
			.where(eq(corpoServiceGit.id, row.id))
			.returning();
		return { decision: null, sha: null, row: updated, error };
	}
};

export const findDuePolls = (now: Date) =>
	db.query.corpoServiceGit.findMany({
		where: and(
			eq(corpoServiceGit.pollEnabled, true),
			or(
				isNull(corpoServiceGit.nextPollAt),
				lte(corpoServiceGit.nextPollAt, now),
			),
		),
	});

const globalForPoller = globalThis as unknown as {
	__corpoPoller?: ReturnType<typeof setInterval>;
};

export const startCorpoPoller = ({
	enqueue,
	tickMs = 15_000,
}: {
	enqueue: EnqueueDeployment;
	tickMs?: number;
}) => {
	if (globalForPoller.__corpoPoller) {
		return;
	}
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			const due = await findDuePolls(new Date());
			for (const row of due) {
				await pollServiceGit(row, enqueue);
			}
		} catch (error) {
			console.error("Corpo poller tick failed", error);
		} finally {
			running = false;
		}
	};
	globalForPoller.__corpoPoller = setInterval(() => void tick(), tickMs);
	void tick();
	console.log("Corpo git poller started");
};
