import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { applications } from "../db/schema/application";
import { compose } from "../db/schema/compose";

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

export const corpoServiceGit = pgTable(
	"corpo_service_git",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		pollEnabled: boolean("pollEnabled").notNull().default(false),
		pollIntervalSeconds: integer("pollIntervalSeconds").notNull().default(60),
		lastPolledAt: timestamp("lastPolledAt"),
		nextPollAt: timestamp("nextPollAt"),
		lastSeenSha: text("lastSeenSha"),
		lastPollError: text("lastPollError"),
		consecutiveFailures: integer("consecutiveFailures").notNull().default(0),
		httpsUsername: text("httpsUsername"),
		httpsToken: text("httpsToken"),
		updatedAt: timestamp("updatedAt").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("corpo_service_git_application_idx").on(table.applicationId),
		uniqueIndex("corpo_service_git_compose_idx").on(table.composeId),
	],
);
