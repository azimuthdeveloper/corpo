import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import { findServiceGit, type ServiceTarget } from "./git-auth";
import { MIN_POLL_INTERVAL_SECONDS } from "./git-poll";
import { corpoServiceGit } from "./schema";

const ensureServiceGit = async (target: ServiceTarget) => {
	const existing = await findServiceGit(target);
	if (existing) return existing;
	const [created] = await db
		.insert(corpoServiceGit)
		.values({
			applicationId: target.applicationId ?? null,
			composeId: target.composeId ?? null,
		})
		.onConflictDoNothing()
		.returning();
	return created ?? (await findServiceGit(target))!;
};

export const getServiceGitSettings = async (target: ServiceTarget) => {
	const row = await findServiceGit(target);
	return {
		pollEnabled: row?.pollEnabled ?? false,
		pollIntervalSeconds: row?.pollIntervalSeconds ?? 60,
		lastPolledAt: row?.lastPolledAt ?? null,
		nextPollAt: row?.nextPollAt ?? null,
		lastSeenSha: row?.lastSeenSha ?? null,
		lastPollError: row?.lastPollError ?? null,
		httpsUsername: row?.httpsUsername ?? null,
		hasHttpsToken: !!row?.httpsToken,
	};
};

export const updateServiceGitPolling = async (
	target: ServiceTarget,
	input: { pollEnabled: boolean; pollIntervalSeconds: number },
) => {
	const row = await ensureServiceGit(target);
	const turningOn = input.pollEnabled && !row.pollEnabled;
	const [updated] = await db
		.update(corpoServiceGit)
		.set({
			pollEnabled: input.pollEnabled,
			pollIntervalSeconds: Math.max(
				input.pollIntervalSeconds,
				MIN_POLL_INTERVAL_SECONDS,
			),
			// Re-baseline when polling is switched on so enabling it never
			// deploys a commit that was pushed while polling was off.
			...(turningOn && {
				lastSeenSha: null,
				nextPollAt: null,
				consecutiveFailures: 0,
				lastPollError: null,
			}),
			updatedAt: new Date(),
		})
		.where(eq(corpoServiceGit.id, row.id))
		.returning();
	return { row: updated!, turningOn };
};

export const updateServiceGitToken = async (
	target: ServiceTarget,
	input: { httpsUsername: string | null; httpsToken: string | null },
) => {
	const row = await ensureServiceGit(target);
	const [updated] = await db
		.update(corpoServiceGit)
		.set({
			httpsUsername: input.httpsUsername?.trim() || null,
			httpsToken: input.httpsToken || null,
			consecutiveFailures: 0,
			nextPollAt: null,
			updatedAt: new Date(),
		})
		.where(eq(corpoServiceGit.id, row.id))
		.returning();
	return updated!;
};

export const getServiceGitRow = (target: ServiceTarget) =>
	ensureServiceGit(target);
