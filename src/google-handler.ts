import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import setupGuide from "../docs/index.html";
import {
	exchangeGoogleCode,
	fetchGoogleUserInfo,
	getGoogleAuthorizeUrl,
	isEmailAllowed,
	isUnderAccountCap,
	type Props,
	parseLimit,
} from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

// gmail.modify covers read, search, labels, trash, drafts, and send,
// while excluding permanent deletion and account settings.
const GOOGLE_SCOPE = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

// The deployment documents itself: visiting the domain explains what this
// server is and how to connect a client to it. The Text module rule in
// wrangler.jsonc inlines the file as a string; bun's own ambient types
// describe .html imports as bundles, hence the cast.
const guide = setupGuide as unknown as string;

app.get(
	"/",
	() =>
		new Response(guide, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		}),
);

app.get("/authorize", async (c) => {
	// Clients register themselves via /register (dynamic client registration),
	// and parseAuthRequest throws on a client_id it has never issued. A foreign
	// client_id usually means external OAuth credentials were pasted into the
	// MCP client's connector settings.
	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch (error) {
		console.error("GET /authorize parse error:", error);
		return c.text(
			"Unknown or invalid OAuth client. Connect without entering any client ID or secret — this server registers MCP clients automatically.",
			400,
		);
	}
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	const client = await c.env.OAUTH_PROVIDER.lookupClient(clientId).catch(() => null);
	if (!client) {
		return c.text(
			"Unknown OAuth client. Connect without entering any client ID or secret — this server registers MCP clients automatically.",
			400,
		);
	}

	if (await isClientApproved(c.req.raw, clientId, env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		const headers = new Headers();
		headers.append("Set-Cookie", sessionBindingCookie);
		return redirectToGoogle(c.req.raw, stateToken, headers);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client,
		csrfToken,
		server: {
			description:
				"Remote MCP server for Gmail. Signing in grants the connecting MCP client access to the chosen Google account's mailbox.",
			name: "Gmail MCP",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		const csrfClearCookie = validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo?.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		// Set-Cookie headers must stay separate; collapsing them through a
		// plain object joins the values and breaks both cookies.
		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		headers.append("Set-Cookie", csrfClearCookie.clearCookie);

		return redirectToGoogle(c.req.raw, stateToken, headers);
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}
});

function redirectToGoogle(request: Request, stateToken: string, headers?: Headers) {
	const h = new Headers(headers);
	h.set(
		"Location",
		getGoogleAuthorizeUrl({
			client_id: env.GOOGLE_CLIENT_ID,
			redirect_uri: new URL("/callback", request.url).href,
			scope: GOOGLE_SCOPE,
			state: stateToken,
		}),
	);
	return new Response(null, { headers: h, status: 302 });
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const [tokens, errResponse] = await exchangeGoogleCode({
		client_id: c.env.GOOGLE_CLIENT_ID,
		client_secret: c.env.GOOGLE_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
	});
	if (errResponse) return errResponse;
	if (!tokens.refresh_token) {
		return c.text(
			"Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/connections and try again.",
			400,
		);
	}

	try {
		const user = await fetchGoogleUserInfo(tokens.access_token);

		if (!user.verified || !isEmailAllowed(user.email, c.env.ALLOWED_EMAILS)) {
			return c.text("This Google account is not allowed on this server", 403);
		}

		// Count the accounts this deployment has ever admitted, and stop new ones
		// past the cap. The marker doubles as the "is this account new" answer.
		const marker = `account:${user.email.toLowerCase()}`;
		const seen = await c.env.OAUTH_KV.get(marker);
		if (!seen) {
			const known = await c.env.OAUTH_KV.list({ prefix: "account:", limit: 1000 });
			if (!isUnderAccountCap(known.keys.length, true, parseLimit(c.env.MAX_ACCOUNTS, 25))) {
				console.warn("account cap reached; refused a new sign-in");
				return c.text(
					"This server has reached its limit of connected accounts. Ask its operator to raise MAX_ACCOUNTS.",
					429,
				);
			}
		}
		await c.env.OAUTH_KV.put(marker, new Date().toISOString());

		const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: user.email,
			},
			props: {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				expiresAt: Date.now() + tokens.expires_in * 1000,
				email: user.email,
				name: user.name ?? user.email,
			} as Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: user.email,
		});

		const headers = new Headers({ Location: redirectTo });
		if (clearSessionCookie) {
			headers.set("Set-Cookie", clearSessionCookie);
		}

		return new Response(null, { status: 302, headers });
	} catch (error) {
		console.error("GET /callback error:", error);
		return c.text("Internal server error", 500);
	}
});

export { app as GoogleHandler };
