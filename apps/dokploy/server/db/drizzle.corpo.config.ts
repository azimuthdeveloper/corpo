import { dbUrl } from "@dokploy/server/db/constants";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "../../packages/server/src/corpo/schema.ts",
	dialect: "postgresql",
	dbCredentials: {
		url: dbUrl,
	},
	out: "drizzle-corpo",
	migrations: {
		table: "corpo_migrations",
		schema: "public",
	},
});
