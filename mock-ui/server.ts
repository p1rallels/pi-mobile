import { extname, join, normalize } from "node:path";

const rootDir = import.meta.dir;
const port = Number(process.env.PORT || "8787");
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
]);

const safePath = (urlPath: string): string => {
	const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
	const normalized = normalize(decoded).replace(/^\.\.(?:\/|$)/, "");
	const relative = normalized === "/" ? "index.html" : normalized.replace(/^\/+/, "");
	return join(rootDir, relative);
};

const assetHeaders = (path: string): HeadersInit => ({
	"content-type": mimeTypes.get(extname(path)) || "application/octet-stream",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
});

export const handleRequest = async (request: Request): Promise<Response> => {
	const url = new URL(request.url);
	const path = safePath(url.pathname);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	return new Response(file, { headers: assetHeaders(path) });
};

if (import.meta.main) {
	Bun.serve({
		host,
		port,
		fetch: handleRequest,
	});
	console.log(`mock ui listening on http://${host}:${port}`);
}
