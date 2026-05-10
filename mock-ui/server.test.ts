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
