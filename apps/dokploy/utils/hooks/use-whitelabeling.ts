import { CORPO_BRANDING } from "@dokploy/server/corpo/branding";

export function useWhitelabeling() {
	return { config: CORPO_BRANDING };
}

export function useWhitelabelingPublic() {
	return { config: CORPO_BRANDING };
}
