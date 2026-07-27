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
		console.error("google token exchange failed:", resp.status, await resp.text());
		return [null, new Response("Failed to exchange authorization code", { status: 500 })];
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
		throw new Error(`google token refresh failed: ${resp.status} ${await resp.text()}`);
	}
	const tokens = (await resp.json()) as GoogleTokens;
	if (!tokens.access_token || typeof tokens.expires_in !== "number") {
		throw new Error("google token refresh returned no usable access token");
	}
	return tokens;
}

export async function fetchGoogleUserInfo(accessToken: string) {
	const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
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
