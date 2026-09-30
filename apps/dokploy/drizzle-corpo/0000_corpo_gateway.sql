CREATE TABLE "corpo_gateway" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"publicHost" text,
	"publicScheme" text DEFAULT 'https' NOT NULL,
	"pathPrefix" text DEFAULT 'cor-' NOT NULL,
	"directHost" text,
	"trustedProxyIps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
