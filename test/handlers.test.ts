import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./runtime-shim";

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
		id: { name: "streamable-http:session-1" },
		storage: {
			get: async (key: string) => storage.get(key),
			put: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
			list: async (options?: { prefix?: string }) =>
				new Map([...storage].filter(([key]) => key.startsWith(options?.prefix ?? ""))),
			delete: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
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
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
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
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
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

/** The MIME a call handed to Gmail, decoded from its base64url raw. */
function sentMime(urlPart: string, method?: string): string {
	const sent = requests.find((r) => r.url.includes(urlPart) && (!method || r.method === method));
	const body = sent?.body as { raw?: string; message?: { raw?: string } } | undefined;
	const encoded = String(body?.raw ?? body?.message?.raw ?? "");
	return new TextDecoder().decode(
		Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
	);
}

/** The readable text inside a MIME body, decoded from its base64 lines. */
function mimeText(mime: string): string {
	const body = mime.split("\r\n\r\n").slice(1).join("\r\n\r\n");
	return new TextDecoder().decode(
		Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0)),
	);
}

describe("create_draft as a reply", () => {
	const serve = () =>
		serveGmail([
			[/\/settings\/sendAs/, () => ({ sendAs: [{ sendAsEmail: "me@example.com" }] })],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1", threadId: "t-m1" } })],
		]);

	test("joins the thread with the headers other clients need", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(
			await tool(handlers, "create_draft")({ body: "my answer", replyToMessageId: "m1" }),
		);
		expect(out.draftId).toBe("d1");
		expect(out.threadId).toBe("t-m1");

		const created = requests.find((r) => r.url.endsWith("/drafts"));
		const posted = (created?.body ?? {}) as { message?: { threadId?: string } };
		expect(posted.message?.threadId).toBe("t-m1");
		const mime = sentMime("/drafts");
		expect(mime).toContain("In-Reply-To: <orig@mail.example.com>");
		expect(mime).toContain("References: <orig@mail.example.com>");
		expect(mime).toContain("Subject: Re: Quarterly report");
		expect(mime).toContain("To: alice@example.com");
		expect(mime).toContain("Cc: bob@example.com, carol@example.com");
	});

	test("quotes the original under the body", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "my answer", replyToMessageId: "m1", quote: true });
		const text = mimeText(sentMime("/drafts"));
		expect(text).toContain("my answer");
		expect(text).toContain("> the original body");
		expect(text).toContain("wrote:");
	});

	test("leaves the original out when asked not to quote", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "my answer", replyToMessageId: "m1", quote: false });
		const text = mimeText(sentMime("/drafts"));
		expect(text).toContain("my answer");
		expect(text).not.toContain("> the original body");
	});

	// A caller that names its own recipients owns all of them; deriving a Cc
	// beside a written To would copy people the caller chose to leave out.
	test("a written To replaces the derived recipients whole", async () => {
		const { handlers } = await boot();
		serve();
		await tool(
			handlers,
			"create_draft",
		)({ body: "b", replyToMessageId: "m1", to: "only@example.com" });
		const mime = sentMime("/drafts");
		expect(mime).toContain("To: only@example.com");
		expect(mime).not.toContain("Cc:");
	});

	test("a fresh draft still needs its recipients spelled out", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		await expect(tool(handlers, "create_draft")({ body: "b" })).rejects.toThrow(/replyToMessageId/);
	});
});

describe("update_draft", () => {
	// A draft as the Gmail UI leaves it after a file is added by hand: the text
	// in an alternative pair, the file beside them, the thread already joined.
	const draft = () => ({
		id: "d1",
		message: {
			id: "dm1",
			threadId: "t-orig",
			payload: {
				mimeType: "multipart/mixed",
				headers: [
					{ name: "To", value: "prof@example.com" },
					{ name: "Cc", value: "assistant@example.com" },
					{ name: "Subject", value: "=?UTF-8?B?5Y6f56i/?=" },
					{ name: "In-Reply-To", value: "<orig@mail.example.com>" },
					{ name: "References", value: "<root@mail.example.com> <orig@mail.example.com>" },
				],
				parts: [
					{
						mimeType: "multipart/alternative",
						parts: [
							{ mimeType: "text/plain", body: { data: b64url("old text") } },
							{ mimeType: "text/html", body: { data: b64url("<p>old text</p>") } },
						],
					},
					{
						mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
						filename: "main.docx",
						body: { attachmentId: "att-1", size: 12 },
					},
				],
			},
		},
	});

	const serve = () =>
		serveGmail([
			[/\/drafts\/d1\?format=full/, () => draft()],
			[/\/messages\/dm1\/attachments\/att-1/, () => ({ size: 12, data: b64url("docx bytes!!") })],
			[/\/drafts\/d1$/, () => ({ id: "d1", message: { id: "dm2", threadId: "t-orig" } })],
		]);

	test("a body change keeps the file, the recipients, and the thread", async () => {
		const { handlers } = await boot();
		serve();
		const out = result(await tool(handlers, "update_draft")({ draftId: "d1", body: "new text" }));
		expect(out.attachments).toEqual(["main.docx"]);

		const put = requests.find((r) => r.method === "PUT");
		const posted = (put?.body ?? {}) as { message?: { threadId?: string } };
		expect(posted.message?.threadId).toBe("t-orig");

		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).toContain("To: prof@example.com");
		expect(mime).toContain("Cc: assistant@example.com");
		expect(mime).toContain("In-Reply-To: <orig@mail.example.com>");
		expect(mime).toContain("References: <root@mail.example.com> <orig@mail.example.com>");
		expect(mime).toContain('filename="main.docx"');
		expect(mime).toContain(btoa("docx bytes!!"));
		expect(mime).toContain(btoa("new text"));
	});

	test("a subject change keeps the text as written", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "update_draft")({ draftId: "d1", subject: "改稿" });
		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).toContain(btoa("old text"));
		expect(mime).toContain(btoa("<p>old text</p>"));
	});

	test("an empty attachments list removes the files on purpose", async () => {
		const { handlers } = await boot();
		serve();
		await tool(handlers, "update_draft")({ draftId: "d1", body: "b", attachments: [] });
		const mime = sentMime("/drafts/d1", "PUT");
		expect(mime).not.toContain("main.docx");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});

	test("refuses to rebuild when a file cannot be read back", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/drafts\/d1\?format=full/, () => draft()],
			[
				/\/messages\/dm1\/attachments\/att-1/,
				() => new Response(JSON.stringify({ error: "gone" }), { status: 404 }),
			],
			[/\/drafts\/d1$/, () => ({ id: "d1" })],
		]);
		await expect(tool(handlers, "update_draft")({ draftId: "d1", body: "b" })).rejects.toThrow(
			/could not be read back/,
		);
		expect(requests.filter((r) => r.method === "PUT")).toHaveLength(0);
	});
});

describe("staged attachments", () => {
	const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	const begin = async (handlers: Map<string, Handler>) =>
		result(
			await tool(
				handlers,
				"stage_attachment_begin",
			)({ filename: "報告書.docx", contentType: DOCX }),
		);

	test("chunks staged in order travel into a draft", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1", message: { id: "dm1" } })]]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("hello!") });
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa(" world") });
		const sealed = result(await tool(handlers, "stage_attachment_finish")({ stagingId }));
		expect(sealed.size).toBe(12);

		await tool(
			handlers,
			"create_draft",
		)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] });
		const mime = sentMime("/drafts", "POST");
		expect(mime).toContain(btoa("hello! world"));
		// The staged name rides along, RFC 2231-encoded for its non-ASCII characters.
		expect(mime).toContain("filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.docx");
	});

	test("append refuses base64 that cannot be joined", async () => {
		const { handlers } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await expect(
			tool(handlers, "stage_attachment_append")({ stagingId, content: "abc" }),
		).rejects.toThrow(/four-character groups/);
	});

	test("an unfinished staging cannot be attached", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1" })]]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("abc") });
		await expect(
			tool(
				handlers,
				"create_draft",
			)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] }),
		).rejects.toThrow(/not finished/);
	});

	test("content and stagingId together are refused", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/drafts$/, () => ({ id: "d1" })]]);
		await expect(
			tool(
				handlers,
				"create_draft",
			)({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{ filename: "a.txt", contentType: "text/plain", content: "YQ==", stagingId: "s-1" },
				],
			}),
		).rejects.toThrow(/never both/);
	});

	test("an upload of raw bytes seals the staging by itself", async () => {
		const { agent, handlers, storage } = await boot();
		serveGmail([[/\/messages\/send/, () => ({ id: "sent", threadId: "t1" })]]);
		const { stagingId, uploadUrl } = (await begin(handlers)) as {
			stagingId: string;
			uploadUrl?: string;
		};
		const meta = storage.get(`staged:${stagingId}`) as { secret: string };
		// The handler was called directly, before any request taught the object
		// its origin, so the URL is assembled the way fetch() would have.
		void uploadUrl;
		const doFetch = (agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(agent);
		const response = await doFetch(
			new Request(
				`https://gmail.example.com/upload/${encodeURIComponent("streamable-http:session-1")}/${stagingId}/${meta.secret}`,
				{ method: "PUT", body: new TextEncoder().encode("raw file bytes") },
			),
		);
		expect(response.status).toBe(200);
		const sealed = (await response.json()) as { size: number; filename: string };
		expect(sealed.size).toBe(14);
		expect(sealed.filename).toBe("報告書.docx");

		await tool(
			handlers,
			"send_message",
		)({ to: "a@example.com", subject: "s", body: "b", attachments: [{ stagingId }] });
		expect(sentMime("/messages/send")).toContain(btoa("raw file bytes"));
	});

	test("a wrong secret is turned away without a hint", async () => {
		const { agent, handlers } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		const doFetch = (agent as { fetch: (r: Request) => Promise<Response> }).fetch.bind(agent);
		const response = await doFetch(
			new Request(
				`https://gmail.example.com/upload/${encodeURIComponent("streamable-http:session-1")}/${stagingId}/not-the-secret`,
				{ method: "PUT", body: "x" },
			),
		);
		expect(response.status).toBe(404);
	});

	test("expired stagings are swept when a new one begins", async () => {
		const { handlers, storage } = await boot();
		serveGmail([]);
		const { stagingId } = (await begin(handlers)) as { stagingId: string };
		await tool(handlers, "stage_attachment_append")({ stagingId, content: btoa("old") });
		const key = `staged:${stagingId}`;
		const meta = storage.get(key) as { at: number };
		storage.set(key, { ...meta, at: Date.now() - 25 * 60 * 60 * 1000 });

		await begin(handlers);
		expect(storage.has(key)).toBe(false);
		expect(storage.has(`${key}:chunk:0`)).toBe(false);
	});

	test("the public route rejects what is not an upload address", async () => {
		const malformed = await worker.fetch(
			new Request("https://example.com/upload/only-a-name", { method: "PUT", body: "x" }),
			{} as never,
			{} as never,
		);
		expect(malformed.status).toBe(404);
		const wrongMethod = await worker.fetch(
			new Request("https://example.com/upload/a/b/c"),
			{} as never,
			{} as never,
		);
		expect(wrongMethod.status).toBe(405);
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

describe("an attachment with no bytes in it", () => {
	// A sender may attach an empty file, and Gmail returns it named with a body
	// of zero length. It is still a file the recipient was sent.
	const withEmpty = message("m1", {
		payload: {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{ mimeType: "text/plain", filename: "empty.txt", body: { size: 0, data: "" } },
				{ mimeType: "text/csv", filename: "real.csv", body: { size: 3, data: b64url("a,b") } },
			],
		},
	});

	test("names it alongside the others", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => withEmpty]]);
		const out = result(await tool(handlers, "get_message")({ messageId: "m1" }));
		expect((out.attachments as { filename: string }[]).map((a) => a.filename)).toEqual([
			"empty.txt",
			"real.csv",
		]);
	});

	// It has no id either, so asking Gmail for it under a blank one is a 404.
	test("returns it without asking Gmail for it", async () => {
		const { handlers } = await boot();
		serveGmail([[/\/messages\/m1\?format=full/, () => withEmpty]]);
		const out = result(
			await tool(
				handlers,
				"get_attachment",
			)({
				messageId: "m1",
				attachmentId: "",
				filename: "empty.txt",
			}),
		);
		expect(out.filename).toBe("empty.txt");
		expect(out.contentBase64).toBe("");
		expect(requests.filter((r) => r.url.includes("/attachments/"))).toHaveLength(0);
	});

	test("carries it into a forward", async () => {
		const { handlers } = await boot();
		serveGmail([
			[/\/messages\/m1\?format=full/, () => withEmpty],
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
		expect(out.attachmentsForwarded).toBe(2);
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

	// The MCP endpoint has a ceiling of its own, and a streamed message slips
	// past it the same way. This one needs a grant, so it is reached only by
	// someone already allowed to connect.
	test("stops reading an oversized MCP message", async () => {
		const { request, offered } = streamed("/mcp", 128);
		const response = await worker.fetch(request, {} as never, {} as never);
		expect(response.status).toBe(413);
		expect(offered()).toBeLessThan(80);
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

describe("the headers the boundary hands on", () => {
	// The account header is stamped from the decrypted grant, and the framework
	// will read a whole grant out of x-partykit-props if a client writes one.
	// Neither belongs to the client, so neither survives the boundary.
	test("drops a client's own account and props headers", async () => {
		const seen: Headers[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			seen.push(new Request(input).headers);
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			await worker.fetch(
				new Request("https://example.com/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-gmail-mcp-account": "intruder@example.com",
						"x-partykit-props": "eyJlbWFpbCI6ImludHJ1ZGVyQGV4YW1wbGUuY29tIn0=",
					},
					body: "{}",
				}),
				{} as never,
				{} as never,
			);
		} catch {
			// The provider refuses the unauthenticated call; what matters is that
			// nothing downstream ever saw the client's headers.
		} finally {
			globalThis.fetch = original;
		}
		for (const headers of seen) {
			expect(headers.get("x-partykit-props")).toBeNull();
			expect(headers.get("x-gmail-mcp-account")).toBeNull();
		}
	});
});

describe("when the account's identities cannot be read", () => {
	// Which addresses are this account's own decides who a reply comes from and
	// who it copies. A reply is sent once, so a lookup that cannot answer must
	// not fall through to answering as the primary address.
	test("does not send the reply", async () => {
		const { handlers } = await boot();
		serveGmail([
			[
				/\/settings\/sendAs/,
				() => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
			],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		await expect(tool(handlers, "reply_all")({ messageId: "m1", body: "ok" })).rejects.toThrow(
			/send-as identities/,
		);
		expect(requests.filter((r) => r.url.includes("/messages/send"))).toHaveLength(0);
	});

	// A day-old answer is a better guide than none, and it keeps replies working
	// through a passing failure of the settings endpoint.
	test("falls back to the answer it was given before", async () => {
		const { agent, handlers, storage } = await boot();
		storage.set("sendAs", {
			at: Date.now() - 48 * 60 * 60 * 1000,
			addresses: ["me@example.com", "sales@example.com"],
		});
		void agent;
		serveGmail([
			[
				/\/settings\/sendAs/,
				() => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
			],
			[/\/messages\/m1\?format=full/, () => message("m1")],
			[/\/messages\/send/, () => ({ id: "sent", threadId: "t-m1" })],
		]);
		const out = result(await tool(handlers, "reply_all")({ messageId: "m1", body: "ok" }));
		expect(out.to).toEqual(["alice@example.com"]);
	});
});

describe("forwarding a long message", () => {
	// A quotation may be trimmed because the reader already has the original.
	// A forward is the original, and the person it reaches has no other copy.
	const long = Array.from(
		{ length: 300 },
		(_, i) => `Paragraph ${i}: this is an ordinary sentence of the kind a report is made of.`,
	).join("\n\n");

	test("carries the whole body, not a quotation's worth of it", async () => {
		const { handlers } = await boot();
		const report = message("m1", {
			payload: {
				mimeType: "text/plain",
				headers: [
					{ name: "From", value: "Alice <alice@example.com>" },
					{ name: "To", value: "me@example.com" },
					{ name: "Subject", value: "Quarterly report" },
				],
				body: { data: b64url(long) },
			},
		});
		serveGmail([
			[/\/messages\/m1\?format=full/, () => report],
			[/\/messages\/send/, () => ({ id: "f1", threadId: "t2" })],
		]);
		await tool(handlers, "forward_message")({ messageId: "m1", to: "b@example.com" });

		const sent = requests.find((r) => r.url.includes("/messages/send"));
		const encoded = String((sent?.body as { raw?: string } | undefined)?.raw ?? "");
		const mime = new TextDecoder().decode(
			Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
		);
		const carried = new TextDecoder().decode(
			Uint8Array.from(atob((mime.split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, "")), (c) =>
				c.charCodeAt(0),
			),
		);
		expect(carried).toContain("Paragraph 299:");
		expect(carried).not.toContain("truncated:");
	});
});
