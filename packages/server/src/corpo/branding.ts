export interface PublicWhitelabelingConfig {
	appName: string | null;
	appDescription: string | null;
	logoUrl: string | null;
	loginLogoUrl: string | null;
	faviconUrl: string | null;
	customCss: string | null;
	ogImageUrl: string | null;
	errorPageTitle: string | null;
	errorPageDescription: string | null;
	footerText: string | null;
	docsUrl: string | null;
	supportUrl: string | null;
}

// Imported by client components, so this module must stay free of server-only imports.
export const CORPO_BRANDING: PublicWhitelabelingConfig = {
	appName: "Corpo",
	appDescription: "Internal application hosting platform.",
	logoUrl: null,
	loginLogoUrl: null,
	faviconUrl: null,
	customCss: null,
	ogImageUrl: null,
	errorPageTitle: null,
	errorPageDescription: null,
	footerText: null,
	docsUrl: null,
	supportUrl: null,
};

export const getPublicWhitelabelingConfig =
	async (): Promise<PublicWhitelabelingConfig> => CORPO_BRANDING;
