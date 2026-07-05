/**
 * nwslapp-card — the match-card PNG renderer, split out of nwslapp-match-watcher.
 *
 * WHY THIS EXISTS: the cron watcher used to import ./card statically, dragging satori +
 * resvg-wasm + 3 woff fonts (~3.4MB) into EVERY isolate's module graph. A cold-started cron
 * tick paid that module-eval CPU and got killed → "Exceeded CPU Time Limits" (663/24h, all on
 * cold ticks; warm ticks were fine). Lazy-importing the renderer is NOT an option on Workers
 * (WASM can't be instantiated inside a request handler — "Wasm code generation disallowed by
 * embedder"). So the renderer lives here instead: a fetch-only Worker with NO cron, whose
 * cold-start cost never touches the watcher's per-tick budget. The renderer itself (card.ts)
 * is unchanged — this is only a second entry point + wrangler config.
 *
 * The iOS Notification Service Extension downloads GET /card/<id>?... to attach the PNG to a
 * rich push. The watcher's `imageUrl` points here (CARD_PUBLIC_URL), and the watcher keeps a
 * permanent /card/* → 302 redirect for any push APNs stored and delivers late.
 */
import { handleCard } from "./card";

export interface Env {
	/** Service binding to the sibling proxy (its /crest route, used by card.ts renderSvg).
	 *  A binding, not a workers.dev fetch: same-account Worker→Worker over the public URL
	 *  fails with Cloudflare error 1042. Only env dependency — no KV/cron/secrets/vars. */
	PROXY: Fetcher;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/") {
			return new Response(
				"nwslapp-card — match-card PNG renderer. GET /card/<matchId>?e&h&a&hs&as&min&sc&hid&aid",
				{ status: 200 },
			);
		}

		// Server-rendered match-card PNG (downloaded by the NSE). Only route that renders.
		if (request.method === "GET" && url.pathname.startsWith("/card/")) {
			return handleCard(request, env, ctx);
		}

		return new Response("Not found.", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
