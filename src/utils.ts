// A stalled call to Google would hold the session object open for as long as
// the connection lasts, so these give up on the same terms the Gmail calls do.
const GOOGLE_TIMEOUT_MS = 30_000;

// Context from the auth process, encrypted and stored inside the MCP token grant,
// provided to the agent as this.props.
export type Props = {
	email: string;
	name: string;
	accessToken: string;
	refreshToken: string;
	// Unix ms when accessToken expires.
	expiresAt: number;
};

// The MCP endpoint is public and clients self-register, so who may finish a
// Google sign-in is decided by ALLOWED_EMAILS. Patterns, comma-separated:
//   user@example.com  a single account
//   *@example.com     any account in that domain
//   *                 any verified Google account, making the server a relay
//                     anyone may bind to their own mailbox
// An empty setting admits no one. A grant only ever reaches the mailbox that
// authenticated it, so a wider list never widens access to existing accounts.
export function isEmailAllowed(email: string, allowList: string | undefined): boolean {
	const address = email.trim().toLowerCase();
	const at = address.indexOf("@");
	if (at < 0) return false;
	const domain = address.slice(at);
	const patterns = (allowList ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return patterns.some(
		(p) => p === "*" || p === address || (p.startsWith("*@") && p.slice(1) === domain),
	);
}

// A deployment that admits a whole domain, or anyone, should still not admit
// an unbounded number of accounts: Google caps unverified apps at 100 users,
// and every grant consumes the deployment's own quota afterwards. Accounts
// already admitted keep working once the cap is reached; only new ones stop.
export function isUnderAccountCap(knownAccounts: number, isNewAccount: boolean, cap: number) {
	if (!isNewAccount) return true;
	if (!Number.isFinite(cap) || cap <= 0) return false;
	return knownAccounts < cap;
}

export function parseLimit(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getGoogleAuthorizeUrl({
	client_id,
	redirect_uri,
	scope,
	state,
}: {
	client_id: string;
	redirect_uri: string;
	scope: string;
	state: string;
}) {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", client_id);
	url.searchParams.set("redirect_uri", redirect_uri);
	url.searchParams.set("scope", scope);
	url.searchParams.set("state", state);
	url.searchParams.set("response_type", "code");
	// Required to receive a refresh token; without prompt=consent Google
	// omits it on re-authorization of an already-granted client.
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.href;
}

export type GoogleTokens = {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	// What the account actually granted, which is not always what was asked for.
	scope?: string;
};

export async function exchangeGoogleCode({
	client_id,
	client_secret,
	code,
	redirect_uri,
}: {
	client_id: string;
	client_secret: string;
	code: string | undefined;
	redirect_uri: string;
}): Promise<[GoogleTokens, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}
	const resp = await fetch("https://oauth2.googleapis.com/token", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: "authorization_code",
		}).toString(),
	});
	if (!resp.ok) {
		const detail = await readBoundedText(resp.body);
		console.error("google token exchange failed:", resp.status, detail);
		// Google refuses a spent, mismatched or expired code with a 4xx. Passing
		// that back as a server fault tells the person signing in to wait for a
		// fix that is not coming; what they need to do is start again.
		return [
			null,
			resp.status >= 400 && resp.status < 500
				? new Response("Google refused this sign-in. Start the connection again.", { status: 400 })
				: new Response("Failed to exchange authorization code", { status: 502 }),
		];
	}
	const tokens = (await resp.json()) as GoogleTokens;
	if (!tokens.access_token) {
		return [null, new Response("Missing access token", { status: 400 })];
	}
	return [tokens, null];
}

export async function refreshGoogleToken({
	client_id,
	client_secret,
	refresh_token,
}: {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}): Promise<GoogleTokens> {
	const resp = await fetch("https://oauth2.googleapis.com/token", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			refresh_token,
			grant_type: "refresh_token",
		}).toString(),
	});
	if (!resp.ok) {
		const detail = await readBoundedText(resp.body);
		// invalid_grant is the refresh token itself dying, and every tool call
		// fails on it identically until the account signs in again. Naming the
		// ways it dies turns a wall of identical failures into the action that
		// ends them: a password change revokes every Gmail-scoped token the
		// account has issued, revoking the app by hand does the same, and an
		// OAuth app left in Testing has each sign-in expire after seven days.
		if (detail.includes("invalid_grant")) {
			throw new Error(
				"Google no longer accepts this account's sign-in. Reconnect this MCP server and sign in again. This follows a password change (Google revokes Gmail tokens with it) or a revocation at https://myaccount.google.com/connections; when it recurs every 7 days, the deployment's OAuth app is in Testing — publish it to In production at https://console.cloud.google.com/auth/overview.",
			);
		}
		throw new Error(`google token refresh failed: ${resp.status} ${detail}`);
	}
	const tokens = (await resp.json()) as GoogleTokens;
	if (!tokens.access_token || typeof tokens.expires_in !== "number") {
		throw new Error("google token refresh returned no usable access token");
	}
	return tokens;
}

export async function fetchGoogleUserInfo(accessToken: string) {
	const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		throw new Error(`userinfo failed: ${resp.status}`);
	}
	const info = (await resp.json()) as {
		email?: string;
		verified_email?: boolean;
		name?: string;
	};
	if (!info.email || typeof info.email !== "string") {
		throw new Error("userinfo returned no email");
	}
	// Only an explicit true counts: an absent field is not evidence of ownership.
	return { email: info.email, verified: info.verified_email === true, name: info.name };
}

// A sender that declares no length would otherwise decide how much memory a
// request occupies, so the body is counted as it arrives and refused part-way
// rather than after it has all been held.
export class BodyTooLarge extends Error {}

// What an error response is worth reading. The peer decides how much it sends,
// and a diagnostic that has to be held whole before it can be trimmed is one
// the sender chose the size of.
export const MAX_ERROR_BYTES = 4_000;

export async function readBoundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
	const reader = body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.byteLength;
		if (total >= MAX_ERROR_BYTES) {
			await reader.cancel();
			break;
		}
	}
	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(joined.subarray(0, MAX_ERROR_BYTES));
}

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new BodyTooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return body;
}
