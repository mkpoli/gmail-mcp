import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./runtime-shim";

const { GoogleHandler } = await import("../src/google-handler");
const { bindStateToSession, createOAuthState } = await import("../src/workers-oauth-utils");

const realFetch = globalThis.fetch;

/** A KV namespace that keeps its values in a Map. */
function memoryKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
		list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
	};
}

/** Google answering the code exchange and the userinfo lookup. */
function serveGoogle(email: string, overrides: { verified?: boolean; scope?: string } = {}) {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("oauth2.googleapis.com/token")) {
			return new Response(
				JSON.stringify({
					access_token: "at",
					refresh_token: "rt",
					expires_in: 3600,
					scope:
						overrides.scope ??
						"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/oauth2/v2/userinfo")) {
			return new Response(
				JSON.stringify(
					email
						? { email, verified_email: overrides.verified ?? true, name: "Tester" }
						: { name: "Tester" },
				),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("no route", { status: 404 });
	}) as unknown as typeof fetch;
}

const authRequest = {
	clientId: "client-1",
	redirectUri: "https://client.example/cb",
	scope: [],
	state: "s",
	responseType: "code",
	codeChallenge: "c",
	codeChallengeMethod: "S256",
};

/** A callback request carrying state that was properly issued and bound. */
async function callbackRequest(kv: ReturnType<typeof memoryKv>) {
	const { stateToken } = await createOAuthState(authRequest as never, kv as never);
	const { setCookie } = await bindStateToSession(stateToken);
	const cookie = (setCookie.split(";")[0] ?? "").trim();
	return new Request(`https://server.example/callback?code=abc&state=${stateToken}`, {
		headers: { Cookie: cookie },
	});
}

function envFor(kv: ReturnType<typeof memoryKv>, allowed: string, completed: string[]) {
	return {
		GOOGLE_CLIENT_ID: "id",
		GOOGLE_CLIENT_SECRET: "secret",
		ALLOWED_EMAILS: allowed,
		MAX_ACCOUNTS: "25",
		OAUTH_KV: kv,
		OAUTH_PROVIDER: {
			completeAuthorization: async ({ props }: { props: { email: string } }) => {
				completed.push(props.email);
				return { redirectTo: "https://client.example/cb?code=granted" };
			},
		},
	};
}

beforeEach(() => {
	globalThis.fetch = realFetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("who the callback admits", () => {
	// isEmailAllowed has its own tests; this covers the place it is called, where
	// dropping the condition would let any Google account bind this deployment
	// while every other test stayed green.
	test("turns away an account outside the allowlist", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("stranger@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "owner@example.com", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(completed).toEqual([]);
	});

	test("admits an account on the allowlist", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com");
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "owner@example.com", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(302);
		expect(completed).toEqual(["owner@example.com"]);
	});

	// An address Google has not confirmed belongs to the person signing in is
	// not evidence of anything, whatever the allowlist says.
	test("turns away an address Google has not verified", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", { verified: false });
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(completed).toEqual([]);
	});
});

describe("the cookies the approval sets", () => {
	// Three cookies are appended to one response. Collapsing them through a
	// plain object joins the values, and the session binding never lands — every
	// sign-in then fails at the callback with a green test suite.
	test("sends each of them as its own header", async () => {
		const kv = memoryKv();
		const env = {
			...envFor(kv, "*", []),
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => authRequest,
				lookupClient: async () => ({ clientId: "client-1", clientName: "Test Client" }),
			},
		};

		const dialog = await GoogleHandler.fetch(
			new Request("https://server.example/authorize?client_id=client-1"),
			env as never,
			{} as never,
		);
		const html = await dialog.text();
		const state = html.match(/name="state" value="([^"]+)"/)?.[1] ?? "";
		const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? "";
		expect(state).not.toBe("");
		const csrfCookie = (dialog.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

		const approved = await GoogleHandler.fetch(
			new Request("https://server.example/authorize", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Cookie: csrfCookie.trim(),
				},
				body: new URLSearchParams({ state, csrf_token: csrf }).toString(),
			}),
			env as never,
			{} as never,
		);

		const cookies = approved.headers.getSetCookie();
		expect(cookies).toHaveLength(3);
		expect(cookies.some((c) => c.startsWith("__Host-CONSENTED_STATE="))).toBe(true);
	});
});

describe("a consent that granted only some of what was asked", () => {
	// Google lets someone untick a permission and approve the rest. Without the
	// address there is nothing to key the allowlist, the account cap or the
	// session owner by, so the sign-in cannot finish — and it used to fail at
	// the userinfo lookup as a bare 500.
	test("says which permission was withheld instead of failing late", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("", {
			scope:
				"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.profile",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/email permission/);
		expect(completed).toEqual([]);
	});

	test("still refuses a consent without the Gmail permission", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toMatch(/Gmail permission/);
	});

	// The state that brought the browser in was spent on arrival, so a bare
	// error page would strand the person: nothing on it could reopen Google's
	// screen, and the whole flow would have to be restarted from the client.
	test("offers a retry that reopens Google's consent screen directly", async () => {
		const kv = memoryKv();
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const response = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", []) as never,
			{} as never,
		);
		const html = await response.text();
		const retry = html.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)?.[1] ?? "";
		expect(retry).toContain("state=");

		// The link only works if its state token exists and is bound to this
		// browser: a fresh state in KV and a fresh session cookie beside it.
		const state = new URL(retry.replace(/&amp;/g, "&")).searchParams.get("state") ?? "";
		expect(await kv.get(`oauth:state:${state}`)).not.toBeNull();
		const cookie = response.headers.get("Set-Cookie") ?? "";
		expect(cookie).toContain("__Host-CONSENTED_STATE=");
	});

	test("a retried consent that grants everything completes the sign-in", async () => {
		const kv = memoryKv();
		const completed: string[] = [];
		serveGoogle("owner@example.com", {
			scope: "https://www.googleapis.com/auth/userinfo.email",
		});
		const refusal = await GoogleHandler.fetch(
			await callbackRequest(kv),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		const html = await refusal.text();
		const retry = (html.match(/href="(https:\/\/accounts\.google\.com[^"]+)"/)?.[1] ?? "").replace(
			/&amp;/g,
			"&",
		);
		const state = new URL(retry).searchParams.get("state") ?? "";
		const cookie = (refusal.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

		serveGoogle("owner@example.com");
		const second = await GoogleHandler.fetch(
			new Request(`https://server.example/callback?code=abc&state=${state}`, {
				headers: { Cookie: cookie },
			}),
			envFor(kv, "*", completed) as never,
			{} as never,
		);
		expect(second.status).toBe(302);
		expect(completed).toEqual(["owner@example.com"]);
	});
});
