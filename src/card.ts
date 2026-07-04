/**
 * Match-card PNG renderer (Tier B of rich notifications).
 *
 * Composes both teams' crests + the live score + a status pill into a single PNG
 * that the iOS Notification Service Extension downloads and attaches to the push.
 * The payload only ever carries the URL (well under APNs' 4KB), never image bytes.
 *
 * Pipeline: a flexbox tree → satori → SVG → resvg-wasm → PNG. No headless browser,
 * so it fits a Cloudflare Worker; output is deterministic and cacheable.
 *
 * Crest resolution (so a crest is NEVER missing — the most visible failure of this
 * feature): self-hosted proxy /crest PNG (primary, yours, fast) → ESPN CDN by team
 * id (fallback) → a colored ring + abbreviation drawn in the SVG (last resort only).
 * When a real crest loads it is drawn as-is, with NO added ring/circle/border.
 */

import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import inter400 from "./fonts/inter-400.woff";
import inter600 from "./fonts/inter-600.woff";
import inter800 from "./fonts/inter-800.woff";

interface CardEnv {
	/** Service binding to the sibling proxy worker — its GET /crest/{ABBR} serves the
	 *  self-hosted crests. A binding (not a workers.dev fetch) is required: same-account
	 *  Worker→Worker over the public URL fails with Cloudflare error 1042. */
	PROXY: Fetcher;
}

/** Parsed /card query → render inputs. */
interface CardOptions {
	matchId: string;
	event: string; // kickoff | goal | halftime | fulltime | correction
	homeAbbr: string;
	awayAbbr: string;
	homeScore: number;
	awayScore: number;
	minute?: number;
	scorer?: string;
	homeId?: string; // ESPN team id (for crest fallback)
	awayId?: string;
	comp: string; // competition label for the footer (default "NWSL")
	oldHomeScore?: number; // correction only: the pre-VAR score, struck through next to the corrected one
	oldAwayScore?: number;
}

// Team accent colors by abbreviation — mirrored from the app's DesignTeamColors
// (brightened for a dark canvas). Used for the *fallback* ring + the scorer dot.
const ACCENTS: Record<string, string> = {
	LA: "#E6447B",
	BAY: "#2F80E8",
	BOS: "#2FA85A",
	CHI: "#6BA4FF",
	DEN: "#239E80",
	GFC: "#7FD4C1",
	HOU: "#FF8A3D",
	KC: "#30C7E8",
	NC: "#E0354B",
	SEA: "#6E7FFF",
	ORL: "#B07CE8",
	POR: "#FF4D6D",
	LOU: "#C7A8FF",
	SD: "#FFB340",
	UTA: "#FFD60A",
	WAS: "#FF4D5E",
};

function accent(abbr: string): string {
	return ACCENTS[abbr.toUpperCase()] ?? "#8E8E93";
}

/** "#RRGGBB" → {r,g,b}. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const h = hex.replace("#", "");
	return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Mix a hex toward white by `amt` (0–1) — the lightened team tint for the abbreviations. */
function lighten(hex: string, amt: number): string {
	const { r, g, b } = hexToRgb(hex);
	const mix = (c: number) => Math.round(c + (255 - c) * amt);
	const hx = (c: number) => c.toString(16).padStart(2, "0");
	return `#${hx(mix(r))}${hx(mix(g))}${hx(mix(b))}`;
}

/** Team-color wash CSS: home from the left edge, away from the right, at 25% — the same
 *  wash as the schedule cards + the V2 live activity, layered OVER the base dark gradient. */
function teamWashCss(homeAbbr: string, awayAbbr: string): string {
	const h = hexToRgb(accent(homeAbbr)), a = hexToRgb(accent(awayAbbr));
	return (
		"linear-gradient(100deg, " +
		`rgba(${h.r},${h.g},${h.b},0.25) 0%, rgba(${h.r},${h.g},${h.b},0) 34%, ` +
		`rgba(${a.r},${a.g},${a.b},0) 66%, rgba(${a.r},${a.g},${a.b},0.25) 100%)`
	);
}

// Status pill per event (label + foreground + translucent background).
function pill(event: string): { label: string; fg: string; bg: string } {
	switch (event) {
		case "halftime":
			return { label: "HT", fg: "#FF9F0A", bg: "rgba(255,159,10,0.18)" };
		case "fulltime":
			return { label: "FT", fg: "#30D158", bg: "rgba(48,209,88,0.18)" };
		case "correction": // VAR reversal — red, unmistakably NOT a goal
			return { label: "GOAL DISALLOWED", fg: "#FF453A", bg: "rgba(255,69,58,0.20)" };
		default: // kickoff + goal are both live
			return { label: "● LIVE", fg: "#FF453A", bg: "rgba(255,69,58,0.18)" };
	}
}

// resvg-wasm needs its module initialized exactly once per isolate.
let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
	if (!wasmReady) wasmReady = initWasm(resvgWasm);
	return wasmReady;
}

/** Base64-encode bytes in chunks (avoids a huge spread blowing the call stack). */
function base64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Resolve one crest to a `data:` PNG URI (satori can't fetch URLs itself), or null
 * if every image source failed (the caller then draws the ring+abbreviation).
 */
async function crestDataUri(env: CardEnv, abbr: string, espnId: string | undefined): Promise<string | null> {
	// Self-hosted crest via the PROXY SERVICE BINDING (source 0), ESPN CDN by team id as
	// the fallback (source 1). The binding is essential: a plain fetch to the proxy's
	// workers.dev URL returns Cloudflare error 1042 (same-account Worker→Worker over the
	// public URL is blocked) — that 404 page, not a missing crest, is what made the
	// self-hosted crest appear "dead" and every card fall back to the ring. The binding
	// routes the subrequest in-process to the proxy. (Host in the URL is ignored by the
	// binding; only the path matters.)
	const sources: Array<() => Promise<Response>> = [
		() => env.PROXY.fetch(`https://proxy/crest/${encodeURIComponent(abbr)}`),
	];
	if (espnId) sources.push(() => fetch(`https://a.espncdn.com/i/teamlogos/soccer/500/${espnId}.png`));

	for (let i = 0; i < sources.length; i++) {
		try {
			const res = await sources[i]();
			if (!res.ok) {
				console.log(`[card] crest source ${i} for ${abbr} → ${res.status}`);
				continue;
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.byteLength === 0) continue;
			const mime = res.headers.get("content-type") || "image/png";
			return `data:${mime};base64,${base64(bytes)}`;
		} catch (err) {
			console.log(`[card] crest source ${i} for ${abbr} threw: ${err}`);
		}
	}
	console.log(`[card] crest fallback to ring+abbr for ${abbr}`);
	return null;
}

// Minimal hyperscript so we can build satori's element tree without JSX/runtime.
type Node = { type: string; props: Record<string, unknown> };
function el(type: string, style: Record<string, unknown>, children?: unknown): Node {
	return { type, props: { style, children } };
}

/** One team column: real badge artwork (no ring) when available, else ring+abbr. */
function teamColumn(abbr: string, crest: string | null): Node {
	const badge = crest
		? // Real crest — drawn as-is, NO ring/circle/border (the spec is explicit).
			{ type: "img", props: { src: crest, width: 60, height: 60, style: { objectFit: "contain" } } }
		: // Fallback only: colored ring + abbreviation.
			el(
				"div",
				{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					width: 60,
					height: 60,
					borderRadius: 30,
					border: `3px solid ${accent(abbr)}`,
					color: accent(abbr),
					fontSize: 19,
					fontWeight: 800,
				},
				abbr,
			);
	return el(
		"div",
		{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9, width: 120 },
		[badge, el("div", { fontSize: 15, fontWeight: 600, color: lighten(accent(abbr), 0.35) }, abbr)],
	);
}

/** Build the full match-card SVG via satori. */
async function renderSvg(env: CardEnv, opts: CardOptions): Promise<string> {
	const [homeCrest, awayCrest] = await Promise.all([
		crestDataUri(env, opts.homeAbbr, opts.homeId),
		crestDataUri(env, opts.awayAbbr, opts.awayId),
	]);
	const p = pill(opts.event);
	const showMinute = opts.minute != null && (opts.event === "goal" || opts.event === "kickoff");
	const isCorrection = opts.event === "correction" && opts.oldHomeScore != null && opts.oldAwayScore != null;

	// Score: a correction shows the pre-VAR score struck through next to the corrected one (the strike +
	// red pill carry the meaning — no arrow glyph, which Inter may not cover). Otherwise the plain score.
	const scoreRow = isCorrection
		? el("div", { display: "flex", flexDirection: "row", alignItems: "baseline", gap: 16 }, [
				el(
					"div",
					{ fontSize: 32, fontWeight: 700, color: "rgba(255,255,255,0.38)", textDecoration: "line-through" },
					`${opts.oldHomeScore} – ${opts.oldAwayScore}`,
				),
				el("div", { fontSize: 56, fontWeight: 800, color: "#ffffff" }, `${opts.homeScore} – ${opts.awayScore}`),
			])
		: el("div", { fontSize: 56, fontWeight: 800, color: "#ffffff" }, `${opts.homeScore} – ${opts.awayScore}`);

	// Sub-line: minute for goals/kickoff, a "VAR REVIEW" tag for a correction, else an invisible spacer.
	const subLine = isCorrection
		? el("div", { fontSize: 15, fontWeight: 700, letterSpacing: 1.2, color: "#FF453A" }, "VAR REVIEW")
		: showMinute
			? el("div", { fontSize: 17, fontWeight: 600, color: "#FF9F0A" }, `${opts.minute}'`)
			: el("div", { fontSize: 17, color: "transparent" }, "·");

	const center = el(
		"div",
		{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
		[
			el(
				"div",
				{
					fontSize: 15,
					fontWeight: 800,
					letterSpacing: 1.4,
					textTransform: "uppercase",
					color: p.fg,
					backgroundColor: p.bg,
					padding: "5px 14px",
					borderRadius: 999,
				},
				p.label,
			),
			scoreRow,
			subLine,
		],
	);

	const body = el(
		"div",
		{
			display: "flex",
			flexDirection: "row",
			alignItems: "center",
			justifyContent: "space-between",
			padding: "26px 30px 18px",
		},
		[teamColumn(opts.homeAbbr, homeCrest), center, teamColumn(opts.awayAbbr, awayCrest)],
	);

	const scorerText = opts.scorer ? `${opts.scorer}${opts.minute != null ? ` ${opts.minute}'` : ""}` : "";
	const footer = el(
		"div",
		{
			display: "flex",
			flexDirection: "row",
			alignItems: "center",
			justifyContent: "space-between",
			padding: "14px 30px",
			borderTop: "1px solid rgba(255,255,255,0.08)",
			backgroundColor: "rgba(0,0,0,0.18)",
		},
		[
			el("div", { fontSize: 17, fontWeight: 700, letterSpacing: 2, color: "rgba(255,255,255,0.45)" }, opts.comp),
			scorerText
				? el(
						"div",
						{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 },
						[
							el("div", { width: 9, height: 9, borderRadius: 5, backgroundColor: accent(opts.homeAbbr) }, ""),
							el("div", { fontSize: 17, fontWeight: 600, color: "rgba(255,255,255,0.82)" }, scorerText),
						],
					)
				: el("div", {}, ""),
		],
	);

	// Team-color wash layered OVER the base dark gradient but UNDER the content (an
	// absolutely-positioned first child paints behind the flex-flow body/footer).
	const wash = el(
		"div",
		{
			position: "absolute",
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			backgroundImage: teamWashCss(opts.homeAbbr, opts.awayAbbr),
		},
		"",
	);

	const root = el(
		"div",
		{
			position: "relative",
			display: "flex",
			flexDirection: "column",
			width: "100%",
			height: "100%",
			backgroundColor: "#13151d",
			backgroundImage: "linear-gradient(158deg, #1d2030 0%, #0f1118 100%)",
			fontFamily: "Inter",
			color: "#ffffff",
		},
		[wash, body, footer],
	);

	return satori(root as unknown as Parameters<typeof satori>[0], {
		width: 720,
		height: 296,
		fonts: [
			{ name: "Inter", data: inter400, weight: 400, style: "normal" },
			{ name: "Inter", data: inter600, weight: 600, style: "normal" },
			{ name: "Inter", data: inter800, weight: 800, style: "normal" },
		],
	});
}

function parseOptions(url: URL): CardOptions {
	const matchId = url.pathname.slice("/card/".length);
	const q = url.searchParams;
	const num = (v: string | null) => {
		const n = parseInt(v ?? "", 10);
		return Number.isFinite(n) ? n : undefined;
	};
	return {
		matchId,
		event: q.get("e") ?? "goal",
		homeAbbr: q.get("h") ?? "",
		awayAbbr: q.get("a") ?? "",
		homeScore: num(q.get("hs")) ?? 0,
		awayScore: num(q.get("as")) ?? 0,
		minute: num(q.get("min")),
		scorer: q.get("sc") ?? undefined,
		homeId: q.get("hid") ?? undefined,
		awayId: q.get("aid") ?? undefined,
		comp: q.get("comp") ?? "NWSL",
		oldHomeScore: num(q.get("oh")),
		oldAwayScore: num(q.get("oa")),
	};
}

/**
 * GET /card/<matchId>?e&h&a&hs&as&min&sc&hid&aid → match-card PNG.
 *
 * Cached at the edge keyed by the full URL (which encodes matchId/event/score), so
 * one render serves every recipient of the same event and re-renders only when the
 * score changes. A render failure returns 500 (loud) — the watcher then simply omits
 * `imageUrl` so the NSE delivers the text-only notification (honest degrade, never a
 * blank or a push that looks broken).
 */
export async function handleCard(request: Request, env: CardEnv, ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default;
	const cached = await cache.match(request);
	if (cached) return cached;

	const url = new URL(request.url);
	const opts = parseOptions(url);
	if (!opts.homeAbbr || !opts.awayAbbr) {
		return new Response("missing ?h and ?a", { status: 400 });
	}

	try {
		await ensureWasm();
		const svg = await renderSvg(env, opts);
		const png = new Resvg(svg, { fitTo: { mode: "width", value: 720 } }).render().asPng();
		// Copy into a fresh ArrayBuffer so the Response body is a plain BodyInit.
		const body = png.slice().buffer;
		const res = new Response(body, {
			status: 200,
			headers: {
				"Content-Type": "image/png",
				// Score is in the URL, so a given card is immutable → cache hard.
				"Cache-Control": "public, max-age=86400",
			},
		});
		ctx.waitUntil(cache.put(request, res.clone()));
		return res;
	} catch (err) {
		console.log(`[card] render failed for ${opts.matchId} (${opts.event}): ${err}`);
		return new Response(`card render failed: ${err}`, { status: 500 });
	}
}
