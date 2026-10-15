import { expect, test } from "bun:test";
import { handleRequest } from "./server";

test("serves the mock ui shell", async () => {
	const response = await handleRequest(new Request("http://127.0.0.1:8787/"));
	const body = await response.text();
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	expect(body).toContain("id=\"sessions-list\"");
});

test("rejects missing files", async () => {
	const response = await handleRequest(new Request("http://127.0.0.1:8787/nope"));
	expect(response.status).toBe(404);
});

test("serves the real frontend under /public for the canvas mock", async () => {
	const engine = await handleRequest(new Request("http://127.0.0.1:8787/public/app/canvas/camera.js"));
	expect(engine.status).toBe(200);
	expect(engine.headers.get("content-type")).toContain("text/javascript");
	const page = await handleRequest(new Request("http://127.0.0.1:8787/canvas.html"));
	expect(await page.text()).toContain("/public/canvas.css");
	const escape = await handleRequest(new Request("http://127.0.0.1:8787/public/%2e%2e/%2e%2e/src/server.ts"));
	expect(escape.status).toBe(404);
});
