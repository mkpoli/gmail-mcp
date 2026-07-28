import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The agent is a Durable Object, and importing it pulls in the Cloudflare
// runtime modules. Standing those in lets the tool handlers — where the logic
// that talks to Gmail actually lives — be exercised without one.
class Stub {}
const runtimeShim: unknown = new Proxy(
	{ env: {}, default: {} },
	{
		get: (target: Record<string, unknown>, prop: string) => (prop in target ? target[prop] : Stub),
		has: () => true,
		ownKeys: () => [
			"env",
			"default",
			"WorkerEntrypoint",
			"DurableObject",
			"RpcTarget",
			"WorkflowEntrypoint",
			"EmailMessage",
			"connect",
			"exports",
			"__esModule",
		],
		getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: Stub }),
	},
);
for (const name of [
	"cloudflare:workers",
	"cloudflare:email",
	"cloudflare:sockets",
	"cloudflare:workflows",
]) {
	mock.module(name, () => runtimeShim);
}

const { GmailMCP } = await import("../src/index");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
type Route = (url: string, init: RequestInit) => unknown;

const realFetch = globalThis.fetch;

function parseBody(body: BodyInit | null | undefined): unknown {
	if (!body) return undefined;
	const text = String(body);
	try {
		return JSON.parse(text);
	} catch {
		return Object.fromEntries(new URLSearchParams(text));
	}
}

/** Every Gmail request the agent made during a test. */
let requests: { url: string; method: string; body: unknown }[] = [];

/** Stands Gmail up from a table of path matchers. */
function serveGmail(routes: [RegExp, Route][]) {
	globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		requests.push({
			url,
			method: init.method ?? "GET",
			// A token refresh posts a form; everything else posts JSON.
			body: parseBody(init.body),
		});
		for (const [pattern, route] of routes) {
			if (pattern.test(url)) {
				const value = route(url, init);
				if (value instanceof Response) return value;
				return new Response(JSON.stringify(value), { status: 200 });
			}
		}
		return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
	}) as unknown as typeof fetch;
}

function makeAgent(email = "me@example.com") {
	const handlers = new Map<string, Handler>();
	const storage = new Map<string, unknown>();
	const agent = Object.create(GmailMCP.prototype) as Record<string, unknown>;
	agent.server = {
		tool: (name: string, _d: string, _s: unknown, cb: Handler) => handlers.set(name, cb),
	};
	agent.props = {
		email,
		name: "Tester",
		accessToken: "access-token",
		refreshToken: "refresh-token",
		expiresAt: Date.now() + 3_600_000,
	};
	agent.ctx = {
		storage: {
			get: async (key: string) => storage.get(key),
			put: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
		},
	};
	agent.env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
	return { agent, handlers, storage };
}

async function boot(email?: string) {
	const made = makeAgent(email);
	await (made.agent as { init: () => Promise<void> }).init();
	return made;
}

/** A handler that must exist, so a missing one fails loudly rather than quietly. */
function tool(handlers: Map<string, Handler>, name: string): Handler {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`no handler registered for ${name}`);
	return handler;
}

/** The JSON a tool answered with. */
function result(reply: { content: { text: string }[] }): Record<string, unknown> {
	return JSON.parse(reply.content[0]?.text ?? "{}");
}

const b64url = (s: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const message = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	threadId: `t-${id}`,
	labelIds: ["INBOX"],
	snippet: `snippet ${id}`,
	payload: {
		mimeType: "text/plain",
		headers: [
			{ name: "From", value: "Alice <alice@example.com>" },
			{ name: "To", value: "me@example.com, bob@example.com" },
			{ name: "Cc", value: "carol@example.com" },
			{ name: "Subject", value: "Quarterly report" },
			{ name: "Date", value: "Mon, 27 Jul 2026 10:00:00 +0000" },
			{ name: "Message-ID", value: "<orig@mail.example.com>" },
		],
		body: { data: b64url("the original body") },
	},
	...overrides,
});

beforeEach(() => {
	requests = [];
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("session ownership", () => {
	test("the first account to call claims the session", async () => {
		const { handlers, storage } = await boot("first@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "first@example.com" })]]);
		await tool(handlers, "whoami")({});
		expect(storage.get("owner")).toBe("first@example.com");
	});

	test("a second account cannot use a claimed session", async () => {
		const { agent, handlers, storage } = await boot("owner@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		await tool(handlers, "whoami")({});

		// The same object, now reached carrying another account's grant.
		(agent as { props: { email: string } }).props.email = "intruder@example.com";
		await expect(tool(handlers, "whoami")({})).rejects.toThrow(/different Google account/);
		expect(storage.get("owner")).toBe("owner@example.com");
	});
});

describe("search_messages", () => {
	test("reports a message that vanished without losing the rest", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\?/, () => ({ messages: [{ id: "m1" }, { id: "gone" }], resultSizeEstimate: 2 })],
			[
				/\/messages\/gone/,
				() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
			],
			[/\/messages\/m1/, () => message("m1")],
		]);
		const out = result(await tool(handlers, "search_messages")({ query: "x", maxResults: 10 }));
		const messages = out.messages as Record<string, unknown>[];
		expect(messages).toHaveLength(2);
		expect(messages[0]?.subject).toBe("Quarterly report");
		expect(messages[1]).toHaveProperty("error");
	});

	test("asks Gmail for the Cc header", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\?/, () => ({ messages: [{ id: "m1" }] })],
			[/\/messages\/m1/, () => message("m1")],
		]);
		await tool(handlers, "search_messages")({ query: "x", maxResults: 1 });
		expect(requests.some((r) => r.url.includes("metadataHeaders=Cc"))).toBe(true);
	});
});

describe("send_message", () => {
	test("refuses a thread id with no message to reply to", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		await expect(
			tool(
				handlers,
				"send_message",
			)({
				to: "a@example.com",
				subject: "s",
				body: "b",
				threadId: "t-1",
			}),
		).rejects.toThrow(/inReplyTo/);
	});

	test("resolves a Gmail id into the Message-ID it threads on", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=metadata/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		await tool(
			handlers,
			"send_message",
		)({
			to: "a@example.com",
			subject: "s",
			body: "b",
			inReplyTo: "m1",
		});
		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const raw = new TextDecoder().decode(
			Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
		);
		expect(raw).toContain("In-Reply-To: <orig@mail.example.com>");
	});
});

describe("reply_all", () => {
	test("answers the sender, keeps the others, drops this account", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(await tool(handlers, "reply_all")({ messageId: "m1", body: "ok" }));
		expect(out.to).toEqual(["alice@example.com"]);
		expect(out.cc).toEqual(["bob@example.com", "carol@example.com"]);
	});

	// Every threading value on the original is written by whoever sent it, and
	// one too wide for a header line used to reach the builder and throw, so a
	// crafted message could not be answered at all.
	test("answers a message whose threading headers cannot be sent back", async () => {
		const { handlers } = await boot();
		const hostile = message("m1");
		hostile.payload.headers = [
			{ name: "From", value: `${"x".repeat(950)}@evil.example.com` },
			{ name: "To", value: "me@example.com, bob@example.com" },
			{ name: "Subject", value: "Quarterly report" },
			{ name: "Message-ID", value: `<${"z".repeat(950)}@evil.example.com>` },
			{ name: "References", value: `<${"w".repeat(950)}@evil.example.com> <real@example.com>` },
		];
		serveGmail([
			[/\/messages\/m1\?format=full/, () => hostile],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(await tool(handlers, "reply_all")({ messageId: "m1", body: "ok" }));
		expect(out.to).toEqual(["bob@example.com"]);

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
		expect(mime).toContain("References: <real@example.com>");
		expect(mime).not.toContain("In-Reply-To:");
		expect(mime).not.toContain("evil.example.com");
	});
});

describe("get_attachment", () => {
	const withAttachment: ReturnType<typeof message> & {
		payload: { parts?: Record<string, unknown>[] };
	} = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{
					mimeType: "text/csv",
					filename: "report.csv",
					body: { attachmentId: "fresh-id", size: 9 },
					headers: [{ name: "Content-Type", value: 'text/csv; charset="utf-8"' }],
				},
			],
		},
	});

	test("uses the id from this read, not the one the caller held", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withAttachment],
			[/attachments\/fresh-id/, () => ({ size: 9, data: b64url("a,b,c\n1,2") })],
		]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "stale-from-an-earlier-read",
				textOnly: true,
			}),
		);
		expect(out.filename).toBe("report.csv");
		expect(out.text).toBe("a,b,c\n1,2");
	});

	test("refuses to guess between two attachments of the same name", async () => {
		const { handlers } = await boot();
		const twin = {
			mimeType: "text/csv",
			filename: "report.csv",
			body: { attachmentId: "second", size: 9 },
		};
		serveGmail([
			[
				/\/messages\/m1\?format=full/,
				() => ({
					...withAttachment,
					payload: {
						mimeType: "multipart/mixed",
						parts: [...(withAttachment.payload.parts ?? []), twin],
					},
				}),
			],
		]);
		await expect(
			tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "stale",
				filename: "report.csv",
			}),
		).rejects.toThrow(/cannot be told apart/);
	});
});

describe("get_thread", () => {
	test("keeps the newest messages and says how many it dropped", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/threads\//, () => ({ messages: [message("m1"), message("m2"), message("m3")] })],
		]);
		const out = result(await tool(handlers, "get_thread")({ threadId: "t1", maxMessages: 2 }));
		expect(out.messageCount).toBe(3);
		expect(out.omitted).toBe(1);
		expect((out.messages as { id: string }[]).map((m) => m.id)).toEqual(["m2", "m3"]);
	});
});

describe("token handling", () => {
	test("refreshes once when several calls find the token expired", async () => {
		const { agent, handlers } = await boot();
		(agent as { props: { expiresAt: number } }).props.expiresAt = Date.now() - 1000;
		serveGmail([
			[/oauth2\.googleapis\.com/, () => ({ access_token: "fresh", expires_in: 3600 })],
			[/\/messages\?/, () => ({ messages: [] })],
		]);
		await Promise.all([
			tool(handlers, "search_messages")({ query: "a", maxResults: 1 }),
			tool(handlers, "search_messages")({ query: "b", maxResults: 1 }),
		]);
		const refreshes = requests.filter((r) => r.url.includes("oauth2.googleapis.com"));
		expect(refreshes).toHaveLength(1);
	});
});

describe("get_thread on a thread too large to read at once", () => {
	// One read returns every message however few were asked for, so a long
	// thread can be unanswerable. The ids are small; the window is fetched
	// a message at a time from those.
	test("enumerates the ids, then fetches only the window", async () => {
		const { handlers } = await boot();
		const ids = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}` }));
		serveGmail([
			[/\/threads\/[^?]+\?format=minimal/, () => ({ messages: ids })],
			[/\/threads\//, () => new Response("thread too large", { status: 413 })],
			[/\/messages\/m3[89]/, (url) => message(url.match(/m\d+/)?.[0] ?? "m")],
		]);
		const out = result(await tool(handlers, "get_thread")({ threadId: "t1", maxMessages: 2 }));
		expect(out.messageCount).toBe(40);
		expect((out.messages as { id: string }[]).map((m) => m.id)).toEqual(["m38", "m39"]);
		// The whole thread was never fetched a second time.
		expect(requests.filter((r) => /\/messages\/m/.test(r.url))).toHaveLength(2);
	});

	test("asks Gmail only for the headers a summary uses", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/threads\//, () => ({ messages: [message("m1")] })]]);
		await tool(handlers, "get_thread")({ threadId: "t1", includeBodies: false });
		const threadCall = requests.find((r) => r.url.includes("/threads/"));
		expect(threadCall?.url).toContain("metadataHeaders=Subject");
	});
});

describe("attachments that arrive whole", () => {
	// Gmail externalises a large part and gives it an id; a small one comes back
	// inside the message with no id. Listing only the first kind loses the
	// second, and a forward then goes out without the file.
	const inlineFile = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{
					mimeType: "text/csv",
					filename: "tiny.csv",
					body: { size: 3, data: b64url("a,b") },
				},
			],
		},
	});

	test("lists one that carries its own bytes", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => inlineFile]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect((out.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
			"tiny.csv",
		]);
	});

	test("returns it without asking Gmail a second time", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => inlineFile]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "tiny.csv",
				textOnly: true,
			}),
		);
		expect(out.text).toBe("a,b");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});
});

describe("what a listing carries", () => {
	// A read that only wanted the body should not pay for the attachments. The
	// bytes are fetched when they are asked for, not carried in every listing.
	test("names an inline attachment without embedding it", async () => {
		const { handlers } = await boot();
		const big = b64url("x".repeat(30_000));
		serveGmail([
			[
				/\/messages\/m1\?format=full/,
				() =>
					message("m1", {
						payload: {
							mimeType: "multipart/mixed",
							parts: [
								{ mimeType: "text/plain", body: { data: b64url("body") } },
								{
									mimeType: "image/png",
									filename: "shot.png",
									body: { size: 30_000, data: big },
								},
							],
						},
					}),
			],
		]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		const listed = (out.attachments as Record<string, unknown>[])[0];
		expect(listed?.filename).toBe("shot.png");
		expect(listed).not.toHaveProperty("data");
		expect(JSON.stringify(out).length).toBeLessThan(5_000);
	});
});
