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

const { GmailMCP, default: worker } = await import("../src/index");

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

	// An object started by a foreign grant holds that account's credentials for
	// as long as it lives, while storage still names the owner. The owner's own
	// calls then pass the caller check and would reach the wrong mailbox, so
	// what they send has to be settled against the owner too.
	test("refuses credentials that no longer belong to the owner", async () => {
		const { agent, handlers } = await boot("owner@example.com");
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		await tool(handlers, "whoami")({});

		// The caller is still the owner — the account the boundary stamped on the
		// request — and only the grant underneath it changed.
		(agent as { callerAccount: string }).callerAccount = "owner@example.com";
		const props = (agent as { props: Record<string, string | number> }).props;
		props.email = "intruder@example.com";
		props.accessToken = "intruder-access-token";
		await expect(tool(handlers, "whoami")({})).rejects.toThrow(/different Google account/);
		expect(requests).toHaveLength(1);
	});
});

describe("a session started by the wrong grant", () => {
	// Starting the object is what binds its credentials, so a grant that does
	// not own the session must not be the one to do it: otherwise the owner's
	// own calls fail for as long as the object lives.
	test("refuses to start, and starts for the owner afterwards", async () => {
		const made = makeAgent("intruder@example.com");
		made.storage.set("owner", "owner@example.com");
		await expect((made.agent as { init: () => Promise<void> }).init()).rejects.toThrow(
			/different Google account/,
		);

		const props = (made.agent as { props: Record<string, string | number> }).props;
		props.email = "owner@example.com";
		await (made.agent as { init: () => Promise<void> }).init();
		serveGmail([[/\/profile/, () => ({ emailAddress: "owner@example.com" })]]);
		const out = result(await tool(made.handlers, "whoami")({}));
		expect(out.emailAddress).toBe("owner@example.com");
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

describe("reply_all from a send-as alias", () => {
	// Mail written to an alias is mail to this account. Treating the alias as a
	// stranger copies it back to the person replying, and answering from the
	// primary address hands the correspondent an address they never had.
	const toAlias = message("m1");
	toAlias.payload.headers = [
		{ name: "From", value: "Alice <alice@example.com>" },
		{ name: "To", value: "sales@example.com" },
		{ name: "Cc", value: "bob@example.com" },
		{ name: "Subject", value: "Order" },
	];

	const serve = () =>
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "sales@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => toAlias],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);

	test("keeps the alias out of the reply and answers from it", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(await tool(handlers, "reply_all")({ messageId: "m1", body: "ok" }));
		expect(out.to).toEqual(["alice@example.com"]);
		expect(out.cc).toEqual(["bob@example.com"]);

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
		expect(mime).toContain("From: sales@example.com");
	});

	test("reads the identities once and remembers them", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "reply_all")({ messageId: "m1", body: "one" });
		await tool(handlers, "reply_all")({ messageId: "m1", body: "two" });
		expect(requests.filter((r) => r.url.includes("/settings/sendAs"))).toHaveLength(1);
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

describe("two attachments that both arrived whole", () => {
	// Gmail gives an id only to a part it externalises, so parts that arrive
	// whole have none and are all published with the same empty one. Matching on
	// that would pick whichever came first and skip the check that refuses to
	// guess.
	const twoSmall = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{ mimeType: "text/csv", filename: "first.csv", body: { size: 7, data: b64url("FIRST,1") } },
				{
					mimeType: "text/csv",
					filename: "second.csv",
					body: { size: 8, data: b64url("SECOND,2") },
				},
			],
		},
	});

	test("returns the one asked for by name", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => twoSmall]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "second.csv",
				textOnly: true,
			}),
		);
		expect(out.filename).toBe("second.csv");
		expect(out.text).toBe("SECOND,2");
	});

	test("refuses to choose between two of the same name", async () => {
		const { handlers } = await boot();
		const sameName = message("m1", {
			payload: {
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/csv", filename: "a.csv", body: { size: 2, data: b64url("A1") } },
					{ mimeType: "text/csv", filename: "a.csv", body: { size: 2, data: b64url("A2") } },
				],
			},
		});
		serveGmail([[/\/messages\/m1\?format=full/, () => sameName]]);
		await expect(
			tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "a.csv",
				textOnly: true,
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

describe("a message that arrived as a file", () => {
	// Abuse reports and bounce chains arrive this way: the mail carries another
	// message as an attachment, and that message carries files of its own.
	const enclosing = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("see attached") } },
				{
					mimeType: "message/rfc822",
					filename: "inner.eml",
					body: { size: 900, attachmentId: "ATT-outer" },
					parts: [
						{
							mimeType: "multipart/mixed",
							parts: [
								{ mimeType: "text/plain", body: { data: b64url("inner body") } },
								{
									mimeType: "application/pdf",
									filename: "invoice.pdf",
									body: { size: 500, attachmentId: "ATT-inner" },
								},
							],
						},
					],
				},
			],
		},
	});

	test("names the file inside it, and says where it is", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => enclosing]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect(out.attachments).toEqual([
			expect.objectContaining({ filename: "inner.eml" }),
			expect.objectContaining({ filename: "invoice.pdf", insideForwardedMessage: true }),
		]);
	});

	// Re-attaching it would send the same file twice — once inside the
	// enclosure and once beside it — and charge the forward for both.
	test("forwards the enclosure once, without the file already inside it", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => enclosing],
			[/\/attachments\//, () => ({ size: 900, data: b64url("outer bytes") })],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		const out = result(
			await tool(
				handlers,
				"forward_message",
			)({
				messageId: "m1",
				to: "b@example.com",
				includeAttachments: true,
			}),
		);
		expect(out.attachmentsForwarded).toBe(1);
		expect(requests.filter((r) => r.url.includes("ATT-inner"))).toHaveLength(0);
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

describe("the public OAuth endpoints", () => {
	// A sender that omits Content-Length picks how much memory the request
	// occupies, and neither endpoint asks for credentials first. What matters is
	// that the refusal happens part-way, so the count is of what was pulled off
	// the stream rather than of what was offered.
	const CHUNK = 64 * 1024;
	const streamed = (path: string, chunks: number) => {
		let pulled = 0;
		const request = new Request(`https://example.com${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new ReadableStream({
				pull(controller) {
					if (pulled >= chunks) return controller.close();
					pulled += 1;
					controller.enqueue(new Uint8Array(CHUNK));
				},
			}),
			duplex: "half",
		});
		return { request, offered: () => pulled };
	};

	// A client registers once and keeps its id, so a caller asking repeatedly is
	// spending a KV write that the grants and tokens of connected accounts need.
	test("turns away a caller registering over and over", async () => {
		const asked: string[] = [];
		const env = {
			REGISTER_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					asked.push(key);
					return { success: asked.length <= 1 };
				},
			},
		};
		const register = () =>
			worker.fetch(
				new Request("https://example.com/register", {
					method: "POST",
					headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
					body: "{}",
				}),
				env as never,
				{} as never,
			);
		expect((await register()).status).not.toBe(429);
		expect((await register()).status).toBe(429);
		expect(asked).toEqual(["203.0.113.9", "203.0.113.9"]);
	});

	for (const path of ["/token", "/register"]) {
		test(`stops reading a body too large to hold at ${path}`, async () => {
			const { request, offered } = streamed(path, 512);
			const response = await worker.fetch(request, {} as never, {} as never);
			expect(response.status).toBe(413);
			// 32 MiB was on offer; a couple of chunks is all it takes to know.
			expect(offered()).toBeLessThan(8);
		});
	}
});
