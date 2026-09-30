CREATE TABLE "corpo_network" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"httpProxy" text,
	"httpsProxy" text,
	"noProxy" text,
	"caCertificates" text,
	"proxyBuilds" boolean DEFAULT true NOT NULL,
	"proxyContainers" boolean DEFAULT false NOT NULL,
	"trustCaInContainers" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
