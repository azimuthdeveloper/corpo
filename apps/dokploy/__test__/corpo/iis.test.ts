import { buildIisWebConfig } from "@dokploy/server/corpo/iis";
import { describe, expect, it } from "vitest";

describe("buildIisWebConfig", () => {
	it("forwards every prefixed path to Corpo unchanged", () => {
		const xml = buildIisWebConfig({
			pathPrefix: "cor-",
			backendHost: "corpo01.internal",
			publicScheme: "https",
		});
		expect(xml).toContain('<match url="^cor-.*" />');
		expect(xml).toContain('url="http://corpo01.internal/{R:0}"');
		expect(xml).toContain(
			'<set name="HTTP_X_FORWARDED_PROTO" value="https" />',
		);
	});

	it("escapes regex and XML characters", () => {
		const xml = buildIisWebConfig({
			pathPrefix: "a.b",
			backendHost: "x<y",
			publicScheme: "http",
		});
		expect(xml).toContain('<match url="^a\\.b.*" />');
		expect(xml).toContain("http://x&lt;y/{R:0}");
	});

	it("matches everything when no prefix is set", () => {
		const xml = buildIisWebConfig({
			pathPrefix: "",
			backendHost: "h",
			publicScheme: "https",
		});
		expect(xml).toContain('<match url=".*" />');
	});
});
