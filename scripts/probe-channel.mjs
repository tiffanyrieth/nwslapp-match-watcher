#!/usr/bin/env node
/**
 * Phase-0 channel-management probe (LOCAL control).
 *
 * Tests whether APNs Broadcast Channel management works with our credentials + bundle id, BEFORE we
 * build the broadcast rail on top of it. Covers two of the three Phase-0.3 risks:
 *   (a) the capital-letter bundle-id `TopicMismatch` report (ours has caps: com.tiffanyrieth.nwslapp.NWSLApp)
 *   (c) auth / ES256 JWT reuse against the dedicated manage host
 * It does NOT test (b) — whether a Cloudflare WORKER can fetch() the non-standard manage port. That is
 * environment-specific and can only be proven from a deployed Worker (see the /probe-channel DEBUG route).
 *
 * ⚠️ Use the APNs AUTH key, NOT the Sign-in-with-Apple key. They are different Apple keys. The SIWA key
 * (K5C7P5KSGX) will fail here with InvalidProviderToken — that's an auth failure, not a channel-API problem.
 *
 * Usage:
 *   APNS_P8=~/Downloads/AuthKey_<APNSKEYID>.p8 \
 *   APNS_KEY_ID=<10-char APNs key id> \
 *   APNS_TEAM_ID=<10-char team id> \
 *   node scripts/probe-channel.mjs [--port 2195|443] [--prod]
 *
 * Default host = sandbox manage host on :2195 (matches a USB debug build's environment).
 */

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const BUNDLE_ID = process.env.APNS_BUNDLE_ID ?? "com.tiffanyrieth.nwslapp.NWSLApp";
const p8Path = (process.env.APNS_P8 ?? "").replace(/^~/, process.env.HOME ?? "");
const keyId = process.env.APNS_KEY_ID ?? "";
const teamId = process.env.APNS_TEAM_ID ?? "";

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const portArg = args.includes("--port") ? args[args.indexOf("--port") + 1] : null;
const port = portArg ?? "2195"; // Apple-documented manage port (sandbox 2195 / prod 2196)
const manageHost = prod ? "api-manage-broadcast.push.apple.com" : "api-manage-broadcast.sandbox.push.apple.com";

if (!p8Path || !keyId || !teamId) {
	console.error("Missing APNS_P8 / APNS_KEY_ID / APNS_TEAM_ID env vars. See header for usage.");
	process.exit(2);
}

function b64url(buf) {
	return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt() {
	const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
	const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
	const signer = createSign("SHA256");
	signer.update(`${header}.${payload}`);
	// ES256 wants raw r‖s (P1363), which Node emits via dsaEncoding: "ieee-p1363".
	const sig = signer.sign({ key: readFileSync(p8Path, "utf8"), dsaEncoding: "ieee-p1363" });
	return `${header}.${payload}.${b64url(sig)}`;
}

const base = `https://${manageHost}:${port}/1/apps/${BUNDLE_ID}/channels`;

async function main() {
	const jwt = signJwt();
	const auth = { authorization: `bearer ${jwt}` };
	console.log(`→ manage host ${manageHost}:${port}  bundle ${BUNDLE_ID}`);

	// CREATE
	const createRes = await fetch(base, {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ "message-storage-policy": 0, "push-type": "LiveActivity" }),
	});
	const channelId = createRes.headers.get("apns-channel-id");
	console.log(`CREATE  ${createRes.status}  apns-channel-id=${channelId ?? "(none)"}  ${await createRes.text().catch(() => "")}`);
	if (!createRes.ok || !channelId) {
		console.error("CREATE failed — stop. (403/InvalidProviderToken ⇒ wrong key; TopicMismatch ⇒ bundle-id casing.)");
		process.exit(1);
	}

	// READ (config)
	const getRes = await fetch(base, { method: "GET", headers: { ...auth, "apns-channel-id": channelId } });
	console.log(`READ    ${getRes.status}  ${await getRes.text().catch(() => "")}`);

	// DELETE (clean up — a channel id can never be recreated, so always delete a probe channel)
	const delRes = await fetch(base, { method: "DELETE", headers: { ...auth, "apns-channel-id": channelId } });
	console.log(`DELETE  ${delRes.status}`);
	console.log(delRes.ok ? "✅ channel management works locally." : "⚠️ delete failed — channel may linger (10k cap, harmless).");
}

main().catch((e) => {
	console.error("Probe threw:", e);
	process.exit(1);
});
