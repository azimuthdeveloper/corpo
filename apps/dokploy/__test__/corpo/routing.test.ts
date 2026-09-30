import { parse } from "dotenv";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

import { prependEnv, resolvePrimaryRoute } from "@dokploy/server/corpo/access";
import {
	buildHostPathRule,
	buildPublicUrl,
	buildSlashRedirectMiddleware,
	normalizeRoutePath,
	slugToRoutePath,
} from "@dokploy/server/corpo/routing";

const applyRedirect = (url: string, path: string) => {
	const middleware = buildSlashRedirectMiddleware(path);
	if (!middleware) return null;
	const { regex, replacement } = middleware.redirectRegex;
	const match = new RegExp(regex).exec(url);
	if (!match) return null;
	return replacement
		.replace("${1}", match[1] ?? "")
		.replace("${2}", match[2] ?? "");
};

describe("normalizeRoutePath", () => {
	it.each([
		[null, null],
		["", null],
		["/", null],
		["cor-app", "/cor-app"],
		["/cor-app/", "/cor-app"],
		["//a/b//", "/a/b"],
	])("%s -> %s", (input, expected) => {
		expect(normalizeRoutePath(input)).toBe(expected);
	});
});

describe("buildHostPathRule", () => {
	it("uses Host only for the root path", () => {
		expect(buildHostPathRule("iis.example", "/")).toBe("Host(`iis.example`)");
		expect(buildHostPathRule("iis.example", null)).toBe("Host(`iis.example`)");
	});

	it("matches the exact path or the path plus a slash, never a longer sibling", () => {
		const rule = buildHostPathRule("iis.example", "/cor-app/");
		expect(rule).toBe(
			"Host(`iis.example`) && (Path(`/cor-app`) || PathPrefix(`/cor-app/`))",
		);
		expect(rule).not.toContain("PathPrefix(`/cor-app`)");
	});
});

describe("buildSlashRedirectMiddleware", () => {
	it("redirects the bare path to a relative trailing-slash URL", () => {
		expect(applyRedirect("http://iis.example/cor-app", "/cor-app")).toBe(
			"/cor-app/",
		);
		expect(applyRedirect("https://iis.example/cor-app?x=1", "/cor-app")).toBe(
			"/cor-app/?x=1",
		);
	});

	it("leaves the slash form and sub-paths alone", () => {
		expect(applyRedirect("http://iis.example/cor-app/", "/cor-app")).toBeNull();
		expect(
			applyRedirect("http://iis.example/cor-app/assets/a.js", "/cor-app"),
		).toBeNull();
		expect(applyRedirect("http://iis.example/cor-apps", "/cor-app")).toBeNull();
	});

	it("escapes regex characters in the path", () => {
		expect(applyRedirect("http://iis.example/a.b", "/a.b")).toBe("/a.b/");
		expect(applyRedirect("http://iis.example/aXb", "/a.b")).toBeNull();
	});

	it("returns null for the root path", () => {
		expect(buildSlashRedirectMiddleware("/")).toBeNull();
	});
});

describe("slugToRoutePath", () => {
	it("adds the prefix once and cleans the slug", () => {
		expect(slugToRoutePath("cor-", "App")).toBe("/cor-app");
		expect(slugToRoutePath("cor-", "cor-app")).toBe("/cor-app");
		expect(slugToRoutePath("cor-", " My Portal! ")).toBe("/cor-my-portal");
		expect(slugToRoutePath("/cor-", "x")).toBe("/cor-x");
		expect(slugToRoutePath("cor-", "!!!")).toBeNull();
	});
});

describe("resolvePrimaryRoute", () => {
	const gateway = { publicHost: "iis.example", publicScheme: "https" };

	it("prefers the IIS route and uses the gateway scheme", () => {
		const route = resolvePrimaryRoute(
			[
				{ host: "app.internal", path: null, https: false, enabled: true },
				{ host: "IIS.example", path: "/cor-app", https: false, enabled: true },
			],
			gateway,
		);
		expect(route).toEqual({
			basePath: "/cor-app",
			publicUrl: "https://IIS.example/cor-app",
		});
	});

	it("falls back to the first enabled domain and its own scheme", () => {
		const route = resolvePrimaryRoute(
			[
				{ host: "off.internal", path: null, https: true, enabled: false },
				{ host: "app.internal", path: "/", https: false, enabled: true },
			],
			gateway,
		);
		expect(route).toEqual({ basePath: "", publicUrl: "http://app.internal" });
	});

	it("returns null without enabled routes", () => {
		expect(resolvePrimaryRoute([], gateway)).toBeNull();
	});
});

describe("prependEnv", () => {
	it("lets values the user set explicitly win", () => {
		const env = prependEnv("A=1\nCORPO_BASE_PATH=/custom", {
			CORPO_BASE_PATH: "/cor-app",
			CORPO_PUBLIC_URL: "https://iis.example/cor-app",
		});
		expect(parse(env)).toEqual({
			A: "1",
			CORPO_BASE_PATH: "/custom",
			CORPO_PUBLIC_URL: "https://iis.example/cor-app",
		});
	});

	it("handles an empty env", () => {
		expect(parse(prependEnv(null, { X: "y" }))).toEqual({ X: "y" });
	});
});

describe("buildPublicUrl", () => {
	it("joins scheme, host and normalized path", () => {
		expect(buildPublicUrl("https", "iis.example", "cor-app/")).toBe(
			"https://iis.example/cor-app",
		);
	});
});
