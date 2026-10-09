// KV WRITE GUARD (owner ruling 2026-10-08, docs/decisions.md "KV writes are reserved for live matches").
//
// KV writes are capped at 1,000/day ACCOUNT-WIDE and shared with the match watcher's live state. Going over
// stops live pushes, the V2 Live Activity and in-app live scores for the rest of the UTC day — the most
// expensive failure this app can have on the free tier. "It's only +96 writes" has slipped in several times,
// so the rule is enforced here instead of in prose: every KV `.put(` in src/ must match a row in
// test/kv-write-allowlist.json (file + enclosing function + key expression + count). This worker's writes ARE
// the live-match budget; a NEW write fails this test unless it is live-match or an owner-approved exception
// (add a row with its category, reason and estimated writes/day). Non-live state belongs in a Durable Object
// (TickMetronome-style storage), Supabase or the Cache API. A row whose site disappeared also fails, so the inventory stays true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Site = { file: string; fn: string; key: string };
type Row = Site & { count: number; category: string; estPerDay: string; reason: string };

const ROOT = new URL("..", import.meta.url).pathname;
const CATEGORIES = new Set(["live-match", "owner-exception", "legacy"]);

function tsFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
	});
}

/** Every `<KV binding>.put(<key>, …)` with its enclosing function and key expression. */
export function scanKvWrites(root: string, bindings: string[]): Site[] {
	const put = new RegExp(`\\b(${bindings.join("|")})\\??\\.put\\(\\s*`, "g");
	const fnDecl = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)|(?:^|\n)[ \t]*(?:private\s+|public\s+)?(?:async\s+)([A-Za-z0-9_]+)\s*\(/g;
	const out: Site[] = [];
	for (const path of tsFiles(join(root, "src"))) {
		const src = readFileSync(path, "utf8");
		const fns = [...src.matchAll(fnDecl)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? m[2] }));
		for (const m of src.matchAll(put)) {
			let i = (m.index ?? 0) + m[0].length;
			let depth = 0;
			let j = i;
			for (; j < src.length; j++) {
				const ch = src[j];
				if ("([{".includes(ch)) depth++;
				else if (")]}".includes(ch)) {
					if (depth === 0) break;
					depth--;
				} else if (ch === "," && depth === 0) break;
			}
			const key = src.slice(i, j).split(/\s+/).join(" ").trim();
			const enclosing = fns.filter((f) => f.at < (m.index ?? 0)).pop()?.name ?? "(top)";
			out.push({ file: relative(root, path), fn: enclosing, key });
		}
	}
	return out;
}

const id = (s: Site) => `${s.file} :: ${s.fn} :: ${s.key}`;

test("every KV write in src/ is an allowlisted live-match / owner-exception / legacy site", () => {
	const allow = JSON.parse(readFileSync(join(ROOT, "test/kv-write-allowlist.json"), "utf8")) as { sites: Row[] };
	const found = new Map<string, number>();
	for (const s of scanKvWrites(ROOT, ["MATCH_STATE"])) found.set(id(s), (found.get(id(s)) ?? 0) + 1);

	const expected = new Map<string, number>();
	for (const r of allow.sites) {
		assert.ok(CATEGORIES.has(r.category), `${id(r)}: category must be live-match | owner-exception | legacy`);
		assert.ok(r.reason?.length > 0 && r.estPerDay?.length > 0, `${id(r)}: needs a reason and an estPerDay`);
		expected.set(id(r), (expected.get(id(r)) ?? 0) + r.count);
	}

	const added = [...found].filter(([k, n]) => n > (expected.get(k) ?? 0)).map(([k, n]) => `${k} (×${n - (expected.get(k) ?? 0)})`);
	assert.deepEqual(
		added,
		[],
		"NEW KV WRITE(S) — KV writes are reserved for live matches (docs/decisions.md, 2026-10-08). Store this " +
			"state in Durable Object storage, Supabase or the Cache API. Only a live-match write " +
			"or an exception the owner approved in advance may be added to test/kv-write-allowlist.json:\n  " +
			added.join("\n  "),
	);
	const gone = [...expected].filter(([k, n]) => (found.get(k) ?? 0) < n).map(([k]) => k);
	assert.deepEqual(gone, [], `Allowlisted KV write(s) no longer in src/ — remove the row(s) so the inventory stays true:\n  ${gone.join("\n  ")}`);
});

test("the scanner sees the live-match writes (self-check)", () => {
	const sites = scanKvWrites(ROOT, ["MATCH_STATE"]);
	assert.ok(sites.some((s) => s.fn === "runWatch"), "scanner found the per-match state writes");
});
