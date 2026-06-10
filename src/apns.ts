/**
 * APNs token-based push — JWT (ES256) signing + send, using Web Crypto (no Node
 * deps). Token auth means one .p8 key signs a short-lived JWT we reuse across
 * sends; far less fuss than per-environment certificates.
 *
 * The JWT is signed with the ECDSA P-256 private key from the .p8 file. Web
 * Crypto's ECDSA sign returns the raw r‖s signature JWS ES256 expects (not DER),
 * so no conversion is needed.
 */

export interface ApnsConfig {
	/** The .p8 private key, PEM form ("-----BEGIN PRIVATE KEY----- …"). */
	keyP8: string;
	keyId: string; // APNs Key ID (the .p8's 10-char id)
	teamId: string; // Apple Developer Team ID
	bundleId: string; // the app's bundle id → apns-topic
	/** api.sandbox.push.apple.com (dev builds) or api.push.apple.com (TestFlight/App Store). */
	host: string;
}

function base64UrlFromString(input: string): string {
	return base64UrlFromBytes(new TextEncoder().encode(input));
}

function base64UrlFromBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the PEM .p8 to the DER bytes Web Crypto's pkcs8 import wants. */
function pkcs8FromPem(pem: string): ArrayBuffer {
	const body = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s+/g, "");
	const binary = atob(body);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

// Module-scoped reuse: an APNs JWT is valid up to 1hr; regenerate well before that.
// Best-effort only (a fresh isolate starts cold) — correctness doesn't depend on it.
let cached: { token: string; iat: number } | null = null;

/** A signed APNs auth JWT, reused for ~50 minutes. */
export async function apnsJwt(cfg: ApnsConfig): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (cached && now - cached.iat < 3000) return cached.token;

	const header = base64UrlFromString(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
	const payload = base64UrlFromString(JSON.stringify({ iss: cfg.teamId, iat: now }));
	const signingInput = `${header}.${payload}`;

	const key = await crypto.subtle.importKey(
		"pkcs8",
		pkcs8FromPem(cfg.keyP8),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(signingInput),
	);
	const token = `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
	cached = { token, iat: now };
	return token;
}

export interface ApnsResult {
	token: string;
	ok: boolean;
	status: number;
	reason?: string;
}

/** Send one push to one device token. Never throws — returns the per-token result. */
export async function sendApns(
	token: string,
	payload: Record<string, unknown>,
	jwt: string,
	cfg: ApnsConfig,
): Promise<ApnsResult> {
	try {
		const res = await fetch(`https://${cfg.host}/3/device/${token}`, {
			method: "POST",
			headers: {
				authorization: `bearer ${jwt}`,
				"apns-topic": cfg.bundleId,
				"apns-push-type": "alert",
				"apns-priority": "10",
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (res.ok) return { token, ok: true, status: res.status };
		// APNs returns a JSON {reason} on failure (e.g. BadDeviceToken, Unregistered).
		let reason: string | undefined;
		try {
			reason = ((await res.json()) as { reason?: string }).reason;
		} catch {
			reason = undefined;
		}
		return { token, ok: false, status: res.status, reason };
	} catch (err) {
		return { token, ok: false, status: 0, reason: String(err) };
	}
}
