import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

import {
	basicAuthHeader,
	gitAuthEnv,
	gitAuthEnvPrefix,
} from "@dokploy/server/corpo/git-auth";
import {
	computeNextPollAt,
	decidePoll,
	type GitSource,
	lsRemoteHead,
	parseLsRemote,
	redactSecrets,
} from "@dokploy/server/corpo/git-poll";

const noop = async () => {};

describe("decidePoll", () => {
	it("baselines the first time, then deploys only on change", () => {
		expect(decidePoll(null, "a")).toBe("baseline");
		expect(decidePoll("a", "a")).toBe("unchanged");
		expect(decidePoll("a", "b")).toBe("deploy");
	});
});

describe("computeNextPollAt", () => {
	const now = new Date("2026-01-01T00:00:00Z");
	const offset = (interval: number, failures: number) =>
		(computeNextPollAt(now, interval, failures).getTime() - now.getTime()) /
		1000;

	it("uses the interval, with a 30 second floor", () => {
		expect(offset(60, 0)).toBe(60);
		expect(offset(5, 0)).toBe(30);
	});

	it("backs off exponentially on failure, capped at 30 minutes", () => {
		expect(offset(60, 1)).toBe(120);
		expect(offset(60, 3)).toBe(480);
		expect(offset(60, 10)).toBe(1800);
	});

	it("never polls sooner than a long configured interval", () => {
		expect(offset(3600, 5)).toBe(3600);
	});
});

describe("redactSecrets", () => {
	it("removes URL credentials and known tokens", () => {
		const message =
			"fatal: could not read from https://x-access-token:ghs_abc@github.com/o/r.git, token ghs_abc";
		const redacted = redactSecrets(message, ["ghs_abc"]);
		expect(redacted).not.toContain("ghs_abc");
		expect(redacted).toContain("https://***@github.com/o/r.git");
	});
});

describe("parseLsRemote", () => {
	const sha = "a".repeat(40);
	it("returns the exact branch ref only", () => {
		const out = `${"b".repeat(40)}\trefs/heads/main-old\n${sha}\trefs/heads/main\n`;
		expect(parseLsRemote(out, "main")).toBe(sha);
		expect(parseLsRemote(out, "dev")).toBeNull();
		expect(parseLsRemote("", "main")).toBeNull();
	});
});

describe("git auth helpers", () => {
	it("builds a basic auth header with a default username", () => {
		expect(basicAuthHeader(null, "tok")).toBe(
			`Authorization: Basic ${Buffer.from("pat:tok").toString("base64")}`,
		);
	});

	it("produces a shell prefix git reads back verbatim", () => {
		const prefix = gitAuthEnvPrefix("user", "t0k$en'with\"quotes");
		const value = execSync(`${prefix}git config --get http.extraHeader`, {
			encoding: "utf8",
		}).trim();
		expect(value).toBe(basicAuthHeader("user", "t0k$en'with\"quotes"));
	});
});

describe("lsRemoteHead against a real repository", () => {
	let dir: string;
	let bare: string;
	let work: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "corpo-poll-test-"));
		bare = join(dir, "remote.git");
		work = join(dir, "work");
		git(dir, "init", "--bare", "-b", "main", bare);
		git(dir, "init", "-b", "main", work);
		git(work, "config", "user.email", "test@example.com");
		git(work, "config", "user.name", "Test");
		writeFileSync(join(work, "a.txt"), "1");
		git(work, "add", ".");
		git(work, "commit", "-m", "one");
		git(work, "remote", "add", "origin", bare);
		git(work, "push", "origin", "main");
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const source = (branch = "main"): GitSource => ({
		url: `file://${bare}`,
		branch,
		env: {},
		secrets: [],
		cleanup: noop,
	});

	it("sees new commits pushed to the branch", async () => {
		const first = await lsRemoteHead(source());
		expect(first).toBe(git(work, "rev-parse", "HEAD"));

		writeFileSync(join(work, "a.txt"), "2");
		git(work, "commit", "-am", "two");
		git(work, "push", "origin", "main");

		const second = await lsRemoteHead(source());
		expect(second).not.toBe(first);
		expect(decidePoll(first, second)).toBe("deploy");
	});

	it("reports a missing branch clearly", async () => {
		await expect(lsRemoteHead(source("nope"))).rejects.toThrow(
			'Branch "nope" was not found',
		);
	});
});

describe("HTTPS token is sent as a header, not in the URL", () => {
	it("git sends the configured Authorization header", async () => {
		const seen: { auth?: string; url?: string } = {};
		const server = createServer((req, res) => {
			seen.auth = req.headers.authorization;
			seen.url = req.url;
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const token = "secret-pat-123";
		try {
			await expect(
				lsRemoteHead({
					url: `http://127.0.0.1:${port}/org/repo.git`,
					branch: "main",
					env: gitAuthEnv(null, token),
					secrets: [token],
					cleanup: noop,
				}),
			).rejects.toThrow();
		} finally {
			server.close();
		}
		expect(seen.auth).toBe(
			`Basic ${Buffer.from(`pat:${token}`).toString("base64")}`,
		);
		expect(seen.url).not.toContain(token);
	});
});
