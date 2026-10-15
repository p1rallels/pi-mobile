import { describe, expect, test } from "bun:test";
import { renderLaunchAgentPlist, serverAgentSpec, serviceEnvironment } from "../src/launchd.ts";

describe("launchd agents", () => {
	test("renders a keep-alive agent that runs pi-web start from the repo", () => {
		const spec = serverAgentSpec({
			bunPath: "/opt/bun/bin/bun",
			repoDir: "/srv/pi web",
			layout: { launchAgentsDir: "/Users/me/Library/LaunchAgents", logsDir: "/Users/me/.pi-web/logs" },
			environment: { PATH: "/opt/bin:/usr/bin", PI_WEB_MANAGE_CADDY: "0" },
		});
		const plist = renderLaunchAgentPlist(spec);

		expect(plist).toContain("<string>dev.pi-web.server</string>");
		expect(plist).toContain("<string>/opt/bun/bin/bun</string>\n\t\t<string>/srv/pi web/src/cli.ts</string>\n\t\t<string>start</string>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<true/>");
		expect(plist).toContain("<key>PI_WEB_MANAGE_CADDY</key>\n\t\t<string>0</string>");
		expect(plist).toContain("<string>/Users/me/.pi-web/logs/server.log</string>");
	});

	test("escapes xml in paths and values", () => {
		const plist = renderLaunchAgentPlist({
			label: "x",
			programArguments: ["/a&b/<bin>"],
			workingDirectory: "/tmp",
			logPath: "/tmp/log",
			environment: { NOTE: `"quoted" & 'single'` },
		});
		expect(plist).toContain("<string>/a&amp;b/&lt;bin&gt;</string>");
		expect(plist).toContain("<string>&quot;quoted&quot; &amp; &apos;single&apos;</string>");
	});

	test("passes only the environment the service needs", () => {
		const env = serviceEnvironment({ PATH: "/usr/bin", HOME: "/Users/me", OPENAI_API_KEY: "secret", LANG: "en_US.UTF-8" }, { EXTRA: "1" });
		expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8", EXTRA: "1" });
	});

	test("drops the node_modules/.bin entries bun run prepends and dedupes PATH", () => {
		const env = serviceEnvironment({
			PATH: "/srv/pi-web/node_modules/.bin:/srv/node_modules/.bin/:/node_modules/.bin:/opt/homebrew/bin::/usr/bin:/opt/homebrew/bin",
		});
		expect(env).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin" });
	});

	test("leaves PATH out when nothing survives", () => {
		expect(serviceEnvironment({ PATH: "/srv/node_modules/.bin", LANG: "C" })).toEqual({ LANG: "C" });
	});
});
