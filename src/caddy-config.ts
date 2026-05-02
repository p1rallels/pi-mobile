import { writeFile } from "node:fs/promises";
import type { PiWebConfig, PiWebPaths } from "./security-config.ts";

function caddyQuote(value: string): string {
	return JSON.stringify(value);
}

function siteAddress(config: PiWebConfig): string {
	const host = config.caddy.domain?.trim() || config.caddy.listenHost;
	return `${host}:${String(config.caddy.listenPort)}`;
}

function maybeBind(config: PiWebConfig): string {
	const host = config.caddy.listenHost.trim();
	if (!host || host === "0.0.0.0" || host === "::") return "";
	return `\n\tbind ${host}`;
}

function tlsDirective(config: PiWebConfig): string {
	if (config.caddy.serverCert && config.caddy.serverKey) {
		return `tls ${caddyQuote(config.caddy.serverCert)} ${caddyQuote(config.caddy.serverKey)}`;
	}
	return "tls internal";
}

export function buildCaddyfile(config: PiWebConfig): string {
	const target = `127.0.0.1:${String(config.port)}`;
	return `{
	auto_https disable_redirects
}

${siteAddress(config)} {${maybeBind(config)}
	${tlsDirective(config)} {
		client_auth {
			mode require_and_verify
			trusted_ca_cert_file ${caddyQuote(config.caddy.clientCaCert)}
		}
	}

	reverse_proxy ${target} {
		header_up X-Forwarded-Proto https
		header_up X-PI-Web-Client-Cert-Fingerprint {http.request.tls.client.fingerprint}
		header_up X-PI-Web-Client-Cert-Subject {http.request.tls.client.subject}
	}
}
`;
}

export async function writeCaddyfile(paths: PiWebPaths, config: PiWebConfig): Promise<string> {
	const text = buildCaddyfile(config);
	await writeFile(paths.caddyfilePath, text, { encoding: "utf8", mode: 0o600 });
	return text;
}
