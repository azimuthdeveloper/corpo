CREATE TABLE "corpo_service_git" (
	"id" text PRIMARY KEY NOT NULL,
	"applicationId" text,
	"composeId" text,
	"pollEnabled" boolean DEFAULT false NOT NULL,
	"pollIntervalSeconds" integer DEFAULT 60 NOT NULL,
	"lastPolledAt" timestamp,
	"nextPollAt" timestamp,
	"lastSeenSha" text,
	"lastPollError" text,
	"consecutiveFailures" integer DEFAULT 0 NOT NULL,
	"httpsUsername" text,
	"httpsToken" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corpo_service_git" ADD CONSTRAINT "corpo_service_git_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpo_service_git" ADD CONSTRAINT "corpo_service_git_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corpo_service_git_application_idx" ON "corpo_service_git" USING btree ("applicationId");--> statement-breakpoint
CREATE UNIQUE INDEX "corpo_service_git_compose_idx" ON "corpo_service_git" USING btree ("composeId");