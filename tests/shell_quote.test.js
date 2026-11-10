import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAddCommand } from "../src/host-registry.ts";
import { shellQuote } from "../src/shell-quote.ts";

const CASES = [
	["", "''"],
	["pi-web", "pi-web"],
	["/Users/me/code/pi-web", "/Users/me/code/pi-web"],
	["https://box.tail1234.ts.net:8443", "https://box.tail1234.ts.net:8443"],
	["100.64.0.7", "100.64.0.7"],
	["user@host:a=b,c+d%e_f", "user@host:a=b,c+d%e_f"],
	["--label", "--label"],
	["=ls", "'=ls'"],
	["a b", "'a b'"],
	["$(x)", "'$(x)'"],
	["`x`", "'`x`'"],
	["$HOME", "'$HOME'"],
	["${HOME}", "'${HOME}'"],
	["a!b", "'a!b'"],
	["!!", "'!!'"],
	["it's", String.raw`'it'\''s'`],
	["'", String.raw`''\'''`],
	['say "hi"', `'say "hi"'`],
	[String.raw`back\slash`, String.raw`'back\slash'`],
	["a\nb", "'a\nb'"],
	["tab\there", "'tab\there'"],
	["~", "'~'"],
	["~/code", "'~/code'"],
	["*.jsonl", "'*.jsonl'"],
	["a;b&c|d<e>f", "'a;b&c|d<e>f'"],
	["(x){y}[z]", "'(x){y}[z]'"],
	["#x", "'#x'"],
	["café ☕/日本", "'café ☕/日本'"],
];

const SHELLS = [
	["bash", ["--noprofile", "--norc", "-c"]],
	["zsh", ["-f", "-c"]],
];

let root = "";
let home = "";

beforeAll(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "pi-web-shell-quote-"));
	home = join(root, "home");
	mkdirSync(home);
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const scratchDir = () => mkdtempSync(join(root, "case-"));
const markers = (dir) => readdirSync(dir).filter((name) => name.startsWith("pwned"));

// Runs `line` the way a paste would, with each command in `stubs` replaced by a function that prints its argv (NUL-separated)
// instead of running, so the test sees exactly the words the shell built and nothing real runs but the payloads.
function argvFromShell(shell, flags, stubs, line, cwd) {
	const prelude = stubs.map((name) => `${name}() { printf '%s\\0' ${name} "$@"; }`).join("\n");
	const proc = Bun.spawnSync({
		cmd: [shell, ...flags, `${prelude}\n${line}`],
		cwd,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = proc.stdout.toString();
	return { argv: out.split("\0").slice(0, -1), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

describe("shellQuote", () => {
	test.each(CASES)("%p → %s", (value, quoted) => {
		expect(shellQuote(value)).toBe(quoted);
	});
});

describe("the lines pi-web prints for a human to paste", () => {
	test("host discover's host add line stays bare for plain names", () => {
		const host = { id: "box", url: "https://box.tail1234.ts.net:8443", label: "box", ip: "100.64.0.7", online: true };
		expect(hostAddCommand(host)).toBe("pi-web host add box https://box.tail1234.ts.net:8443 --label box --tailscale-name box --tailscale-ip 100.64.0.7 # online");
		expect(hostAddCommand({ ...host, label: "Bob's MacBook", ip: undefined, online: false })).toBe(
			String.raw`pi-web host add box https://box.tail1234.ts.net:8443 --label 'Bob'\''s MacBook' --tailscale-name 'Bob'\''s MacBook' # offline`,
		);
	});
});

describe.each(SHELLS)("pasted into %s", (shell, flags) => {
	test("every quoted case comes back literal", () => {
		const scratch = scratchDir();
		const values = [...CASES.map(([value]) => value), `${scratch}/x$(touch ${scratch}/pwned)`, `\`touch ${scratch}/pwned-tick\``];
		const run = argvFromShell(shell, flags, ["show"], `show ${values.map(shellQuote).join(" ")}`, scratch);
		expect(markers(scratch)).toEqual([]);
		expect(run.argv).toEqual(["show", ...values]);
		expect(run.exitCode).toBe(0);
	});

	test("host discover's host add line runs nothing hidden in a peer's name", () => {
		const scratch = scratchDir();
		const host = {
			id: `box$(touch ${scratch}/pwned-id)`,
			url: `https://box.example.ts.net:8443/\`touch ${scratch}/pwned-url\``,
			label: `peer$(touch ${scratch}/pwned-label)\`touch ${scratch}/pwned-label-tick\` $HOME it's`,
			ip: "100.64.0.7",
			online: true,
		};
		const run = argvFromShell(shell, flags, ["pi-web"], hostAddCommand(host), scratch);
		expect(markers(scratch)).toEqual([]);
		expect(run.argv).toEqual(["pi-web", "host", "add", host.id, host.url, "--label", host.label, "--tailscale-name", host.label, "--tailscale-ip", host.ip]);
		expect(run.exitCode).toBe(0);
	});
});
