import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeNoProxy,
	networkSeedFromEnv,
	PANEL_MANAGED_ENV_KEYS,
	panelEnv,
	serviceEnvUpdateArgs,
} from "@dokploy/server/corpo/network-env";
import { describe, expect, it } from "vitest";

const INSTALLER = join(__dirname, "../../../../install.sh");

// Loads the installer's functions without running it. A temp file instead of
// `source <(...)`, which does not work in macOS's bash 3.2.
const functionsFile = join(
	mkdtempSync(join(tmpdir(), "corpo-installer-")),
	"functions.sh",
);
writeFileSync(
	functionsFile,
	readFileSync(INSTALLER, "utf8").split(/^case "\$\{1:-install\}"/m)[0]!,
);

const runInstallerFn = (script: string, env: Record<string, string>) =>
	execFileSync(
		"bash",
		["-c", `set -euo pipefail; source "${functionsFile}"; ${script}`],
		{
			encoding: "utf8",
			env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
		},
	);

describe("installer stays in sync with the panel", () => {
	const proxyEnvVars = {
		CORPO_HTTP_PROXY: "http://proxy.example.internal:8080",
		CORPO_NO_PROXY: ".example.internal, 10.0.0.0/8,localhost",
	};

	it("builds the same NO_PROXY as mergeNoProxy", () => {
		const out = runInstallerFn("merged_no_proxy", proxyEnvVars).trim();
		expect(out).toBe(mergeNoProxy(proxyEnvVars.CORPO_NO_PROXY));
	});

	it("starts the panel with exactly the env the panel would compute", () => {
		const out = runInstallerFn(
			'CORPO_CA_FILE=/tmp/x; NO_PROXY="$(merged_no_proxy)"; panel_env_args; printf "%s\\n" "${PANEL_ENV[@]}"',
			proxyEnvVars,
		);
		const installerEnv: Record<string, string> = {};
		for (const line of out.split("\n")) {
			if (!line || line === "-e") continue;
			const index = line.indexOf("=");
			installerEnv[line.slice(0, index)] = line.slice(index + 1);
		}

		const seeded = networkSeedFromEnv(installerEnv);
		const desired = panelEnv(seeded, "/etc/dokploy/corpo/ca");
		expect(
			serviceEnvUpdateArgs(desired, installerEnv, PANEL_MANAGED_ENV_KEYS),
		).toEqual([]);
		expect(seeded.noProxy).toBe(".example.internal,10.0.0.0/8");
	});

	it("adds nothing to the panel without a proxy or CA", () => {
		const out = runInstallerFn(
			'panel_env_args; echo "count=${#PANEL_ENV[@]}"',
			{},
		);
		expect(out.trim()).toBe("count=0");
	});
});
