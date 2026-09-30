const escapeXml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const escapeRegex = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface IisSnippetInput {
	pathPrefix: string;
	backendHost: string;
	publicScheme: "http" | "https";
}

// IIS URL Rewrite matches against the path without its leading slash, and
// {R:0} is the whole match, so the original path is forwarded unchanged and
// Traefik on the Corpo box does the per-app routing.
export const buildIisWebConfig = ({
	pathPrefix,
	backendHost,
	publicScheme,
}: IisSnippetInput) => {
	const prefix = pathPrefix.trim().replace(/^\/+/, "");
	const match = prefix ? `^${escapeRegex(prefix)}.*` : ".*";
	return `<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Corpo" stopProcessing="true">
          <match url="${escapeXml(match)}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="${publicScheme}" />
            <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
          </serverVariables>
          <action type="Rewrite" url="http://${escapeXml(backendHost)}/{R:0}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>`;
};

export const IIS_SERVER_COMMANDS = [
	'%windir%\\system32\\inetsrv\\appcmd.exe set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /commit:apphost',
	"%windir%\\system32\\inetsrv\\appcmd.exe set config -section:system.webServer/rewrite/allowedServerVariables /+\"[name='HTTP_X_FORWARDED_PROTO']\" /commit:apphost",
	"%windir%\\system32\\inetsrv\\appcmd.exe set config -section:system.webServer/rewrite/allowedServerVariables /+\"[name='HTTP_X_FORWARDED_HOST']\" /commit:apphost",
];
