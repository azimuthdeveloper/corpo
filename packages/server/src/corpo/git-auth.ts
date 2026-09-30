import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { corpoServiceGit } from "./schema";

export type ServiceTarget =
	| { applicationId: string; composeId?: undefined }
	| { composeId: string; applicationId?: undefined };

export const findServiceGit = async (target: ServiceTarget) =>
	db.query.corpoServiceGit.findFirst({
		where: target.applicationId
			? eq(corpoServiceGit.applicationId, target.applicationId)
			: eq(corpoServiceGit.composeId, target.composeId!),
	});

export const isHttpGitUrl = (url: string) => /^https?:\/\//i.test(url);

// Azure DevOps and most hosts accept any username with a PAT as the password.
export const basicAuthHeader = (username: string | null, token: string) =>
	`Authorization: Basic ${Buffer.from(`${username || "pat"}:${token}`).toString("base64")}`;

// Passed through git's environment config rather than the URL so the token
// never shows up in clone output, deployment logs or `git remote -v`, and it
// also applies to submodules on the same host.
export const gitAuthEnv = (
	username: string | null,
	token: string,
): Record<string, string> => ({
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "http.extraHeader",
	GIT_CONFIG_VALUE_0: basicAuthHeader(username, token),
});

// Prefix for a single command so the token is scoped to that git process
// instead of being exported to the build steps that follow.
export const gitAuthEnvPrefix = (username: string | null, token: string) =>
	Object.entries(gitAuthEnv(username, token))
		.map(([key, value]) => `${key}=${quote([value])} `)
		.join("");

export const gitHttpsAuthPrefix = async (
	url: string | null | undefined,
	entity: { applicationId?: string | null; composeId?: string | null },
) => {
	if (!url || !isHttpGitUrl(url)) {
		return "";
	}
	const target: ServiceTarget | null = entity.applicationId
		? { applicationId: entity.applicationId }
		: entity.composeId
			? { composeId: entity.composeId }
			: null;
	if (!target) {
		return "";
	}
	let settings: Awaited<ReturnType<typeof findServiceGit>>;
	try {
		settings = await findServiceGit(target);
	} catch (error) {
		console.error("Corpo: could not load git HTTPS credentials", error);
		return "";
	}
	if (!settings?.httpsToken) {
		return "";
	}
	return gitAuthEnvPrefix(settings.httpsUsername, settings.httpsToken);
};
