import { describe, expect, it } from "bun:test";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	OAuthError,
	renderApprovalDialog,
	sanitizeText,
	sanitizeUrl,
	validateCSRFToken,
	validateOAuthState,
	verifyApprovalState,
} from "../src/workers-oauth-utils";

const AUTH_REQUEST = {
	clientId: "client-a",
	redirectUri: "https://client.test/cb",
	scope: [],
	state: "opaque",
} as unknown as AuthRequest;

function fakeKV() {
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
	} as unknown as KVNamespace & { store: Map<string, string> };
}

function cookieValue(setCookie: string): string {
	return setCookie.split(";")[0] ?? "";
}

function request(url: string, cookie?: string): Request {
	return new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined);
}

describe("sanitizeUrl", () => {
	it("passes http and https through", () => {
		expect(sanitizeUrl("https://example.com/path")).toBe("https://example.com/path");
		expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
	});

	// The result is written into an href in the approval dialog, so a scheme
	// that executes has to be dropped rather than escaped.
	it.each([
		["javascript", "javascript:alert(1)"],
		["data", "data:text/html;base64,PHNjcmlwdD4="],
		["file", "file:///etc/passwd"],
		["vbscript", "vbscript:msgbox(1)"],
	])("rejects a %s: URL", (_name, url) => {
		expect(sanitizeUrl(url)).toBe("");
	});

	it("rejects control characters and unparseable input", () => {
		expect(sanitizeUrl("https://example.com/\u0000")).toBe("");
		expect(sanitizeUrl("https://example.com/\u001f")).toBe("");
		expect(sanitizeUrl("not a url")).toBe("");
		expect(sanitizeUrl("")).toBe("");
	});
});

describe("sanitizeText", () => {
	it("escapes every character that could break out of markup", () => {
		expect(sanitizeText(`<img src="x" onerror='y'>&`)).toBe(
			"&lt;img src=&quot;x&quot; onerror=&#039;y&#039;&gt;&amp;",
		);
	});
});

describe("validateCSRFToken", () => {
	function form(token?: string): FormData {
		const fd = new FormData();
		if (token !== undefined) fd.set("csrf_token", token);
		return fd;
	}

	it("accepts a token matching its cookie and clears it for reuse", () => {
		const { token, setCookie } = generateCSRFProtection();
		const { clearCookie } = validateCSRFToken(
			form(token),
			request("https://server.test/authorize", cookieValue(setCookie)),
		);
		expect(clearCookie).toContain("Max-Age=0");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
	});

	it("refuses a form with no token", () => {
		const { setCookie } = generateCSRFProtection();
		expect(() =>
			validateCSRFToken(form(), request("https://server.test/authorize", cookieValue(setCookie))),
		).toThrow(OAuthError);
	});

	it("refuses a request with no cookie", () => {
		const { token } = generateCSRFProtection();
		expect(() => validateCSRFToken(form(token), request("https://server.test/authorize"))).toThrow(
			OAuthError,
		);
	});

	// The cross-site case: an attacker can put anything in the form body, but
	// cannot read or set the cookie.
	it("refuses a token that does not match the cookie", () => {
		const mine = generateCSRFProtection();
		const theirs = generateCSRFProtection();
		expect(() =>
			validateCSRFToken(
				form(theirs.token),
				request("https://server.test/authorize", cookieValue(mine.setCookie)),
			),
		).toThrow(/mismatch/i);
	});
});

describe("OAuth state binding", () => {
	async function issue(kv: KVNamespace) {
		const { stateToken } = await createOAuthState(AUTH_REQUEST, kv);
		const { setCookie } = await bindStateToSession(stateToken);
		return { stateToken, cookie: cookieValue(setCookie) };
	}

	it("returns the original request for the browser that consented", async () => {
		const kv = fakeKV();
		const { stateToken, cookie } = await issue(kv);
		const { oauthReqInfo, clearCookie } = await validateOAuthState(
			request(`https://server.test/callback?state=${stateToken}`, cookie),
			kv,
		);
		expect(oauthReqInfo.clientId).toBe("client-a");
		expect(clearCookie).toContain("Max-Age=0");
	});

	it("spends the state once", async () => {
		const kv = fakeKV();
		const { stateToken, cookie } = await issue(kv);
		const url = `https://server.test/callback?state=${stateToken}`;
		await validateOAuthState(request(url, cookie), kv);
		await expect(validateOAuthState(request(url, cookie), kv)).rejects.toThrow(/expired|invalid/i);
	});

	it("refuses a state the browser never consented to", async () => {
		const kv = fakeKV();
		const victim = await issue(kv);
		const attacker = await issue(kv);
		// The attacker's state arrives in a browser holding the victim's cookie.
		await expect(
			validateOAuthState(
				request(`https://server.test/callback?state=${attacker.stateToken}`, victim.cookie),
				kv,
			),
		).rejects.toThrow(/CSRF|does not match/i);
	});

	it("refuses a callback carrying no session cookie", async () => {
		const kv = fakeKV();
		const { stateToken } = await issue(kv);
		await expect(
			validateOAuthState(request(`https://server.test/callback?state=${stateToken}`), kv),
		).rejects.toThrow(/session binding/i);
	});

	it("refuses a callback with no state at all", async () => {
		const kv = fakeKV();
		await expect(validateOAuthState(request("https://server.test/callback"), kv)).rejects.toThrow(
			/Missing state/i,
		);
	});

	it("binds the cookie to the token by hash, not by copying it", async () => {
		const { setCookie } = await bindStateToSession("token-value");
		const value = cookieValue(setCookie).split("=")[1];
		expect(value).not.toBe("token-value");
		expect(value).toMatch(/^[0-9a-f]{64}$/);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Secure");
	});
});

describe("approval blob signing", () => {
	const SECRET = "approval-secret";

	async function dialogState(clientId: string): Promise<string> {
		const response = await renderApprovalDialog(new Request("https://server.test/authorize"), {
			client: { clientId, clientName: "Test client" } as never,
			csrfToken: "csrf",
			server: { name: "Gmail MCP" },
			setCookie: "x=1",
			cookieSecret: SECRET,
			state: { oauthReqInfo: { clientId, redirectUri: "https://client.test/cb" } },
		});
		const html = await response.text();
		return html.match(/name="state" value="([^"]+)"/)?.[1] ?? "";
	}

	it("reads back a blob it signed", async () => {
		const blob = await dialogState("client-a");
		const json = await verifyApprovalState(blob, SECRET);
		expect(json).not.toBeNull();
		expect(JSON.parse(json ?? "{}").oauthReqInfo.clientId).toBe("client-a");
	});

	// The POST acts on what the blob says — which client is granted, and whether
	// a PKCE challenge is present — so an altered one must not be acted on.
	it("refuses a blob whose contents were changed", async () => {
		const blob = await dialogState("client-a");
		const [signature] = blob.split(".");
		const forged = JSON.stringify({
			oauthReqInfo: { clientId: "client-b", redirectUri: "https://attacker.test/cb" },
		});
		const bytes = new TextEncoder().encode(forged);
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		expect(await verifyApprovalState(`${signature}.${btoa(binary)}`, SECRET)).toBeNull();
	});

	it.each([
		["another key", async () => `${await dialogState("client-a")}`],
		["no signature", async () => btoa('{"oauthReqInfo":{"clientId":"x"}}')],
	])("refuses a blob with %s", async (name, make) => {
		const blob = await make();
		const secret = name === "another key" ? "a-different-secret" : SECRET;
		expect(await verifyApprovalState(blob, secret)).toBeNull();
	});
});
