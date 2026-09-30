import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Corpo tables are migrated from apps/dokploy/drizzle-corpo with their own
// journal, so upstream Dokploy migrations can be merged without renumbering.
export const corpoGateway = pgTable("corpo_gateway", {
	id: text("id").primaryKey().default("default"),
	publicHost: text("publicHost"),
	publicScheme: text("publicScheme").notNull().default("https"),
	pathPrefix: text("pathPrefix").notNull().default("cor-"),
	directHost: text("directHost"),
	trustedProxyIps: jsonb("trustedProxyIps")
		.$type<string[]>()
		.notNull()
		.default([]),
	updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});
