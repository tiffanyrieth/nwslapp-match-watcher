import { describe, expect, it } from "vitest";
import { handleCard } from "../src/card";

// A throwaway ExecutionContext for the cache.put side effect.
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = { PROXY_BASE_URL: "https://proxy.example" };

// The render path (satori + resvg-wasm) is verified live via `wrangler dev` +
// screenshots; here we lock the route contract (the param guard) without booting
// the wasm renderer in the test pool.
describe("handleCard", () => {
	it("400s when the team abbreviations are missing", async () => {
		const res = await handleCard(new Request("https://w.example/card/401853925?e=goal"), env, ctx);
		expect(res.status).toBe(400);
	});

	it("400s when only one side is given", async () => {
		const res = await handleCard(new Request("https://w.example/card/401853925?e=goal&h=POR"), env, ctx);
		expect(res.status).toBe(400);
	});
});
