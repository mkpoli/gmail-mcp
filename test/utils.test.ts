import { afterEach, describe, expect, test } from "bun:test";
import {
	exchangeGoogleCode,
	fetchGoogleUserInfo,
	getGoogleAuthorizeUrl,
	refreshGoogleToken,
} from "../src/utils";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init)) as typeof fetch;
}

describe("getGoogleAuthorizeUrl", () => {
	test("builds an offline-consent authorization URL", () => {
		const url = new URL(
			getGoogleAuthorizeUrl({
				client_id: "cid",
				redirect_uri: "https://mcp.example.com/callback",
				scope: "scope-a scope-b",
				state: "st",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("redirect_uri")).toBe("https://mcp.example.com/callback");
		expect(url.searchParams.get("scope")).toBe("scope-a scope-b");
		expect(url.searchParams.get("state")).toBe("st");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
	});
});

describe("exchangeGoogleCode", () => {
	const args = {
		client_id: "cid",
		client_secret: "sec",
		redirect_uri: "https://mcp.example.com/callback",
	};

	test("rejects a missing code without calling Google", async () => {
		let called = false;
		mockFetch(() => {
			called = true;
			return new Response("{}");
		});
		const [tokens, err] = await exchangeGoogleCode({ ...args, code: undefined });
		expect(tokens).toBeNull();
		expect(err?.status).toBe(400);
		expect(called).toBe(false);
	});

	test("posts grant parameters and parses tokens", async () => {
		let sentBody = "";
		mockFetch((url, init) => {
			expect(url).toBe("https://oauth2.googleapis.com/token");
			sentBody = String(init?.body);
			return Response.json({
				access_token: "at",
				refresh_token: "rt",
				expires_in: 3599,
			});
		});
		const [tokens, err] = await exchangeGoogleCode({ ...args, code: "the-code" });
		expect(err).toBeNull();
		expect(tokens).toEqual({ access_token: "at", refresh_token: "rt", expires_in: 3599 });
		const params = new URLSearchParams(sentBody);
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(params.get("code")).toBe("the-code");
	});

	test("tells the caller to start again when Google refuses the code", async () => {
		globalThis.fetch = (async () =>
			new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
		const [tokens, err] = await exchangeGoogleCode({
			client_id: "c",
			client_secret: "s",
			code: "spent",
			redirect_uri: "https://x.test/callback",
		});
		expect(tokens).toBeNull();
		expect(err?.status).toBe(400);
	});

	test("reports an upstream fault as a bad gateway", async () => {
		globalThis.fetch = (async () =>
			new Response("boom", { status: 503 })) as unknown as typeof fetch;
		const [, err] = await exchangeGoogleCode({
			client_id: "c",
			client_secret: "s",
			code: "x",
			redirect_uri: "https://x.test/callback",
		});
		expect(err?.status).toBe(502);
	});

	test("rejects a response without access_token", async () => {
		mockFetch(() => Response.json({ expires_in: 3599 }));
		const [tokens, err] = await exchangeGoogleCode({ ...args, code: "c" });
		expect(tokens).toBeNull();
		expect(err?.status).toBe(400);
	});
});

describe("refreshGoogleToken", () => {
	test("posts refresh grant and returns tokens", async () => {
		mockFetch((url, init) => {
			const params = new URLSearchParams(String(init?.body));
			expect(url).toBe("https://oauth2.googleapis.com/token");
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("rt");
			return Response.json({ access_token: "new-at", expires_in: 3599 });
		});
		const tokens = await refreshGoogleToken({
			client_id: "cid",
			client_secret: "sec",
			refresh_token: "rt",
		});
		expect(tokens.access_token).toBe("new-at");
	});

	test("throws on upstream failure", async () => {
		mockFetch(() => new Response("revoked", { status: 400 }));
		expect(
			refreshGoogleToken({ client_id: "cid", client_secret: "sec", refresh_token: "rt" }),
		).rejects.toThrow("google token refresh failed");
	});

	// invalid_grant reads as a server fault when repeated back raw, and every
	// tool call fails on it the same way until the account signs in again. The
	// error is the one place those instructions can travel.
	test("names what to do when the grant itself has died", async () => {
		mockFetch(
			() =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(
			refreshGoogleToken({ client_id: "cid", client_secret: "sec", refresh_token: "rt" }),
		).rejects.toThrow(/sign in again.*password change.*In production/s);
	});

	test("rejects a refresh response missing access_token or expires_in", async () => {
		mockFetch(() => Response.json({ expires_in: 3599 }));
		expect(
			refreshGoogleToken({ client_id: "cid", client_secret: "sec", refresh_token: "rt" }),
		).rejects.toThrow("no usable access token");
		mockFetch(() => Response.json({ access_token: "at" }));
		expect(
			refreshGoogleToken({ client_id: "cid", client_secret: "sec", refresh_token: "rt" }),
		).rejects.toThrow("no usable access token");
	});
});

describe("fetchGoogleUserInfo", () => {
	test("returns email with verification flag", async () => {
		mockFetch(() => Response.json({ email: "a@example.com", verified_email: true, name: "A" }));
		expect(await fetchGoogleUserInfo("at")).toEqual({
			email: "a@example.com",
			verified: true,
			name: "A",
		});
	});

	test("marks unverified accounts", async () => {
		mockFetch(() => Response.json({ email: "a@example.com", verified_email: false }));
		const info = await fetchGoogleUserInfo("at");
		expect(info.verified).toBe(false);
	});

	test("throws when email is absent", async () => {
		mockFetch(() => Response.json({ verified_email: true }));
		expect(fetchGoogleUserInfo("at")).rejects.toThrow("no email");
	});
});
