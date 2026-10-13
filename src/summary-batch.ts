// ONE batched /summary call per poll (2026-10-13).
//
// WHY: Worker→Worker service-binding calls COUNT toward the Free plan's 50 subrequests per invocation —
// live-tested 2026-10-13 (call 51 threw `Too many subrequests by single Worker invocation`, including inside a
// Durable Object, where this tick runs; not raisable on Free). The watcher used to spend one binding call per
// match per poll (live goal cross-check + pre-kickoff lineup check), × 2 polls per run: ~18 of 50 on an 8-match
// NWSL slate, ~38 at a 17-match FIFA-window peak before any Supabase/APNs call. Now it spends ONE per poll
// (per SUMMARY_BATCH_MAX entries): the proxy's `/watch/summaries` fans each entry out through its own SELF
// binding to the normal /summary route, in the PROXY's invocation and budget. ESPN sees the same requests as
// before — same URLs, same `_lc` cache-bust rules (proxy src/watch-summaries.ts `summaryUrlFor`).

/** Must match the proxy's WATCH_SUMMARIES_MAX (src/watch-summaries.ts). */
export const SUMMARY_BATCH_MAX = 40;

const PROXY_WATCH_SUMMARIES = "https://proxy/watch/summaries";

export interface SummaryWant {
	/** ESPN event id. */
	id: string;
	/** The PROXY's league slug (`usa.nwsl` for the league — see `summaryLeague` in index.ts; ESPN slugs for cups
	 *  + national-team feeds). Must be on the proxy's allowlist or the whole batch 400s. */
	league: string;
	/** Cache-bust (`_lc`) — the live cross-check busts only on the 2nd poll; the lineup check always busts. */
	bust: boolean;
}

/** One summary's outcome. `status` 200 ⇒ `body` is the parsed ESPN summary; anything else = a failed fetch
 *  (the proxy's /summary status, 502 for a malformed body, 0 for a throw). */
export interface SummaryResult {
	status: number;
	body?: unknown;
}

/** Batch URLs for `wants` — deduped by event id (first want wins), chunked at SUMMARY_BATCH_MAX. */
export function summaryBatchUrls(wants: readonly SummaryWant[]): string[] {
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const w of wants) {
		if (seen.has(w.id)) continue;
		seen.add(w.id);
		entries.push(`${w.id}:${w.league}${w.bust ? ":1" : ""}`);
	}
	const urls: string[] = [];
	for (let i = 0; i < entries.length; i += SUMMARY_BATCH_MAX) {
		urls.push(`${PROXY_WATCH_SUMMARIES}?e=${entries.slice(i, i + SUMMARY_BATCH_MAX).join(",")}`);
	}
	return urls;
}

/** Fold one envelope (`[{id,status,body?}]`) into `out`. Anything that isn't that shape is ignored entry by
 *  entry — a missing id simply reads as "no summary" downstream, exactly like a failed per-match fetch. */
export function absorbSummaryEnvelope(envelope: unknown, out: Map<string, SummaryResult>): void {
	if (!Array.isArray(envelope)) return;
	for (const e of envelope) {
		if (!e || typeof e !== "object") continue;
		const { id, status, body } = e as { id?: unknown; status?: unknown; body?: unknown };
		if (typeof id !== "string" || typeof status !== "number") continue;
		out.set(id, status === 200 && body !== undefined ? { status, body } : { status });
	}
}

/** Fetch every wanted summary with ONE proxy call per SUMMARY_BATCH_MAX entries. A whole-batch failure is
 *  logged LOUD and its entries are simply absent — the same per-match semantics as the old individual fetch
 *  failing (scoreboard-only this poll; the lineup check retries next poll). Deliberately NO per-match
 *  fallback: that would re-create the subrequest blow-up this batch exists to prevent. */
export async function fetchSummaries(
	proxy: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
	wants: readonly SummaryWant[],
): Promise<Map<string, SummaryResult>> {
	const out = new Map<string, SummaryResult>();
	for (const url of summaryBatchUrls(wants)) {
		try {
			const res = await proxy.fetch(url, { headers: { Accept: "application/json" } });
			if (!res.ok) {
				console.log(`[watcher] DIAG summary batch HTTP ${res.status} — those matches scoreboard-only this poll`);
				continue;
			}
			absorbSummaryEnvelope(await res.json(), out);
		} catch (err) {
			console.log(`[watcher] DIAG summary batch failed — those matches scoreboard-only this poll: ${err}`);
		}
	}
	return out;
}
