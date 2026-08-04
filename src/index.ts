import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentByName } from "agents";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	b64urlEncode,
	b64urlToStandard,
	buildRfc822,
	bytesToB64,
	canonicalAddress,
	decodeAttachmentText,
	decodeEncodedWords,
	draftContentParts,
	encodedSize,
	extractBody,
	extractHtmlBody,
	type FilePart,
	forwardHeaderBlock,
	forwardHtmlBlock,
	forwardSubject,
	GmailApiError,
	type GmailMessage,
	type GmailPart,
	gmailFetch,
	headerValue,
	type InlineImage,
	MAX_ENCODED_ATTACHMENT_BYTES,
	normalizeMessageId,
	parseAddresses,
	partCharset,
	quoteHtml,
	quotePlain,
	replyRecipients,
	replySubject,
	sanitizeReferences,
	summarizeMessage,
	textPartAttachment,
	truncate,
} from "./gmail";
import { GoogleHandler } from "./google-handler";
import { BodyTooLarge, type Props, readBoundedBody, refreshGoogleToken } from "./utils";

type TokenCache = { accessToken: string; expiresAt: number };

// Gmail returns more than this server reads, and the shape differs by endpoint.
// Responses are described where they are consumed rather than modelled whole.
type GmailUnknown = Record<string, unknown>;

// Named where a response is consumed, holding only the fields that are read.
type MessageList = {
	messages?: { id?: string }[];
	resultSizeEstimate?: number;
	nextPageToken?: string;
};
type LabelList = { labels?: { id?: string; name?: string; type?: string }[] };
type DraftList = { drafts?: { id?: string }[] };
type DraftResult = { id?: string; message?: GmailMessage };
type AttachmentBody = { size?: number; data?: string };

// Character budgets keep decoded mail bodies from flooding Durable Object
// memory or the MCP client's context window.
const BODY_LIMIT = 50_000;
const THREAD_BODY_LIMIT = 10_000;
// Whole-thread ceiling: a long notification thread would otherwise return
// hundreds of kilobytes of quoted machine-generated mail.
const THREAD_TOTAL_BUDGET = 30_000;
// Attachment download ceiling, checked against the part's declared size before
// any bytes are fetched — base64 of a large file would otherwise be buffered
// whole in the session's Durable Object before any cap could apply.
const ATTACHMENT_BYTE_LIMIT = 1_500_000;
// What may come back inside a tool result. The download ceiling above bounds
// memory; this bounds the reply, which is read into an assistant's context
// where base64 costs roughly a token every four characters.
const ATTACHMENT_INLINE_LIMIT = 200_000;
// Carries the authenticated account from the OAuth boundary to the session
// object. Set from the decrypted grant after any inbound copy is removed, so
// what arrives at the object is what the OAuth layer authenticated.
const ACCOUNT_HEADER = "x-gmail-mcp-account";
// How the agent framework will accept a grant if one is written on the request.
const PROPS_HEADER = "x-partykit-props";
// The headers a message summary is built from; nothing else is read.
const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"] as const;
// How long the account's send-as identities are trusted before being read again.
const SEND_AS_TTL_MS = 24 * 60 * 60 * 1000;
// What the MCP transport itself allows a single message to be.
const MCP_MESSAGE_LIMIT = 4 * 1024 * 1024;

// Staged attachments: file bytes held in the session's own storage so that a
// message can carry a file whose base64 would never fit through tool
// arguments. How long an unused staging lives before it is swept.
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
// A stored slice of staged base64. Durable Object values carry up to 2 MB;
// staying at half leaves the metadata beside it out of the reckoning.
const STAGED_CHUNK_CHARS = 1_000_000;
// One appended chunk is stored as one value, so it shares that ceiling.
const MAX_APPEND_CHARS = 1_000_000;
// Raw upload ceiling: these bytes encode to MAX_ENCODED_ATTACHMENT_BYTES of
// base64, which is where the message builder draws its own line.
const MAX_RAW_UPLOAD_BYTES = 6_000_000;
// Everything staged at once, across files. A session stages a file, attaches
// it, and moves on; holding several messages' worth is not what this is for.
const MAX_STAGED_TOTAL_CHARS = 32_000_000;

// What a staging holds beside its chunks. The secret gates the upload URL:
// whoever holds it may fill this one staging, and nothing else.
type StagedMeta = {
	filename: string;
	contentType: string;
	secret: string;
	at: number;
	sealed: boolean;
	chunks: number;
	encodedLength: number;
	// Base64 "=" count seen so far. Padding closes the stream, so anything
	// after it cannot be part of the same file.
	padding: number;
};

const filePartSchema = z.object({
	filename: z.string().optional().describe("Required with content; a staged file brings its own"),
	contentType: z
		.string()
		.optional()
		.describe("Required with content; a staged file brings its own"),
	content: z
		.string()
		.optional()
		.describe("File data as standard base64, for files small enough to pass inline"),
	stagingId: z
		.string()
		.optional()
		.describe("A staged file from the stage_attachment tools, instead of content"),
});
type FilePartArg = z.infer<typeof filePartSchema>;

const inlineImageSchema = z.object({
	cid: z.string().describe('Content-ID referenced from the HTML as <img src="cid:...">'),
	contentType: z
		.string()
		.optional()
		.describe("Required with content; a staged image brings its own"),
	content: z.string().optional().describe("Image data as standard base64"),
	stagingId: z
		.string()
		.optional()
		.describe("A staged image from the stage_attachment tools, instead of content"),
});
type InlineImageArg = z.infer<typeof inlineImageSchema>;

export class GmailMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Gmail MCP",
		version: "0.2.1",
	});

	// The account this object serves, from the header the OAuth boundary stamps.
	private callerAccount: string | null = null;

	// Where this deployment answers, read off arriving traffic. It names the
	// host in upload URLs, which is the one thing a Worker cannot know about
	// itself without being told.
	private origin: string | null = null;

	// A session belongs to the first account that opens it. Durable Object
	// storage settles that here rather than in KV, whose writes take up to a
	// minute to reach another location and resolve by last write — long enough
	// for a second account to read no owner and be admitted.
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		this.origin = url.origin;
		// A staged upload authenticates by its address alone: the boundary sends
		// it here without a grant, and the secret in the path is what
		// stage_attachment_begin handed the session that asked for it.
		if (url.pathname.startsWith("/upload/")) {
			return this.acceptUpload(request, url);
		}
		const account = request.headers.get(ACCOUNT_HEADER)?.toLowerCase();
		if (account) {
			const owner = await this.ctx.storage.get<string>("owner");
			if (owner === undefined) {
				await this.ctx.storage.put("owner", account);
			} else if (owner !== account) {
				return new Response("this MCP session belongs to a different Google account", {
					status: 403,
				});
			}
			this.callerAccount = account;
		}
		return super.fetch(request);
	}

	// What an abandoned session leaves behind: the account that owns it, its
	// most recent access token, and the copy of the grant the agent framework
	// writes on every start — refresh token included, since that is what the
	// grant carries. The agent owns the object's alarm for its own scheduling,
	// so expiry is not ours to add.
	// The transport tears a session down over RPC, without going through fetch(),
	// so the boundary cannot rely on the gate above for that one. It asks here
	// instead. An unclaimed session answers yes: claiming happens on first use.
	async isOwnedBy(email: string): Promise<boolean> {
		const owner = await this.ctx.storage.get<string>("owner");
		return owner === undefined || owner === email.toLowerCase();
	}

	// Access tokens live one hour; the refresh token from props mints new ones.
	// The freshest token is kept in DO storage because props are immutable
	// for the lifetime of the MCP grant.
	private get grantProps(): Props {
		if (!this.props) throw new Error("missing auth props on MCP session");
		return this.props;
	}

	// Props are bound once, when the object starts, from whichever grant woke
	// it — a later request carrying a different account does not replace them.
	// So a session claimed by one account can be started by another's grant,
	// leaving credentials here that name someone else. Which account they are
	// for is settled against the owner in storage rather than assumed from
	// their being present.
	private async ownerProps(): Promise<Props> {
		const owner = await this.ctx.storage.get<string>("owner");
		const props = this.grantProps;
		if (owner !== undefined && props.email.toLowerCase() !== owner) {
			throw new Error("this MCP session belongs to a different Google account");
		}
		return props;
	}

	// The MCP transport addresses this Durable Object by the Mcp-Session-Id
	// header alone, so the session id — not the OAuth grant — would otherwise
	// decide whose mailbox a request reaches. The first grant to touch a session
	// claims it; every later request must present the same account, or the
	// cached Google token of the first account would serve the second. The
	// comparison is only worth anything because the caller comes from the
	// request rather than from the object's start-up state.
	private async assertSessionOwner(): Promise<void> {
		// The account was settled in fetch() above, against this object's own
		// storage. This repeats the comparison for the identity the call is
		// actually running under, and still catches a cold object woken by a
		// different account, whose props would otherwise name that account.
		const caller = this.callerAccount ?? this.grantProps.email.toLowerCase();
		const owner = await this.ctx.storage.get<string>("owner");
		if (owner === undefined) {
			await this.ctx.storage.put("owner", caller);
			return;
		}
		if (owner !== caller) {
			throw new Error("this MCP session belongs to a different Google account");
		}
	}

	// Single-flight guard: concurrent tool calls near expiry share one refresh.
	private refreshing: Promise<string> | null = null;

	private async token(forceRefresh = false): Promise<string> {
		const props = await this.ownerProps();
		if (!forceRefresh) {
			const cached = await this.ctx.storage.get<TokenCache>("token");
			const current = cached ?? {
				accessToken: props.accessToken,
				expiresAt: props.expiresAt,
			};
			if (Date.now() < current.expiresAt - 60_000) {
				return current.accessToken;
			}
		}
		this.refreshing ??= (async () => {
			try {
				const refreshed = await refreshGoogleToken({
					client_id: this.env.GOOGLE_CLIENT_ID,
					client_secret: this.env.GOOGLE_CLIENT_SECRET,
					refresh_token: props.refreshToken,
				});
				const next: TokenCache = {
					accessToken: refreshed.access_token,
					expiresAt: Date.now() + refreshed.expires_in * 1000,
				};
				await this.ctx.storage.put("token", next);
				return next.accessToken;
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	}

	// The addresses this account may send as, beyond the Google address itself.
	// Gmail calls them send-as identities and mail addressed to one is addressed
	// here. They change about as often as an account is set up, so they are kept
	// for a day rather than looked up on every reply.
	//
	// Which identities are this account's own decides both who a reply comes
	// from and who it copies, and a reply is sent once. So a lookup that cannot
	// answer falls back to the last answer it gave, and with nothing to fall
	// back on it stops: an error the caller can retry beats a message that went
	// to the correspondent from an address they were never given.
	private async sendAsAddresses(): Promise<string[]> {
		const cached = await this.ctx.storage.get<{ at: number; addresses: string[] }>("sendAs");
		if (cached && Date.now() - cached.at < SEND_AS_TTL_MS) return cached.addresses;
		try {
			const settings = await this.api<{ sendAs?: { sendAsEmail?: string }[] }>("/settings/sendAs");
			const addresses = (settings.sendAs ?? [])
				.map((identity) => identity.sendAsEmail?.toLowerCase())
				.filter((address): address is string => Boolean(address));
			await this.ctx.storage.put("sendAs", { at: Date.now(), addresses });
			return addresses;
		} catch (error: unknown) {
			if (cached) return cached.addresses;
			throw new Error(
				`could not read this account's send-as identities, so this reply was not sent: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	// One account can open many sessions, so the ceiling has to be counted per
	// account rather than per Durable Object. The platform limiter keeps that
	// count outside any one session.

	private async assertWithinRate(): Promise<void> {
		const limiter = this.env.RATE_LIMITER;
		if (!limiter) return;
		const props = await this.ownerProps();
		const { success } = await limiter.limit({ key: props.email.toLowerCase() });
		if (!success) {
			throw new Error("rate limit reached for this account; retry shortly");
		}
	}

	private async api<T = GmailUnknown>(path: string, init: RequestInit = {}): Promise<T> {
		await this.assertSessionOwner();
		await this.assertWithinRate();
		try {
			return await gmailFetch(await this.token(), path, init);
		} catch (e) {
			if (e instanceof GmailApiError && e.status === 401) {
				// Token revoked or expired early. The props token may be the one
				// that just failed, so refresh unconditionally before retrying.
				return gmailFetch(await this.token(true), path, init);
			}
			// Gmail's per-user rate limit is bursty and one backoff clears most of
			// it, but a write may have already been applied before the error came
			// back — retrying a send would deliver the message twice.
			const idempotent = !init.method || init.method === "GET";
			if (idempotent && e instanceof GmailApiError && (e.status === 429 || e.status === 503)) {
				await new Promise((r) => setTimeout(r, 1200));
				return gmailFetch(await this.token(), path, init);
			}
			throw e;
		}
	}

	// Gmail bills messages.get at 5 quota units against a 250-unit/second budget,
	// so a wide search must not fire every metadata fetch at once.
	private async mapLimited<T, R>(
		items: T[],
		limit: number,
		fn: (item: T) => Promise<R>,
	): Promise<(R | { error: string })[]> {
		const out: (R | { error: string })[] = new Array(items.length);
		let next = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				const item = items[i];
				if (item === undefined) continue;
				try {
					out[i] = await fn(item);
				} catch (e) {
					// A mailbox changes under a wide read: a message is trashed between
					// the listing and the fetch, or Gmail reissues an attachment id.
					// One gone item should not discard the rest of the results.
					out[i] = { error: e instanceof Error ? e.message : String(e) };
				}
			}
		});
		await Promise.all(workers);
		return out;
	}

	// Inline part data first; when Gmail externalizes a large text part as an
	// attachment, fetch and decode those bytes.
	private async messageBody(m: GmailMessage): Promise<string> {
		const inline = extractBody(m.payload);
		if (inline) return inline;
		const ref = textPartAttachment(m.payload);
		if (!ref) return "";
		// The bytes are buffered, decoded and stripped before any character
		// budget applies, so an oversized part is refused on its declared size
		// rather than fetched and then trimmed.
		if (ref.size > ATTACHMENT_BYTE_LIMIT) {
			// get_attachment lists parts that carry a filename, and an externalized
			// body carries none, so pointing there would be a dead end.
			return `[the body of this message is ${ref.size} bytes, past the ${ATTACHMENT_BYTE_LIMIT}-byte limit this server reads; open the message in a mail client]`;
		}
		const att = await this.api<AttachmentBody>(
			`/messages/${encodeURIComponent(m.id ?? "")}/attachments/${encodeURIComponent(ref.attachmentId)}`,
		);
		if (!att?.data) return "";
		return decodeAttachmentText(att.data, ref.mimeType, ref.charset);
	}

	// ---- Staged attachments -------------------------------------------------

	// The upload URL half of staging: raw bytes arrive in one PUT, are encoded
	// here, and seal the staging themselves. Failures answer with the same 404
	// whether the id or the secret was wrong: the address either works or it
	// does not.
	private async acceptUpload(request: Request, url: URL): Promise<Response> {
		if (request.method !== "PUT") {
			return new Response("PUT the raw file bytes to this URL", { status: 405 });
		}
		const [, , , stagingId, secret] = url.pathname.split("/").map(decodeURIComponent);
		const meta = stagingId
			? await this.ctx.storage.get<StagedMeta>(`staged:${stagingId}`)
			: undefined;
		// The secret is an unguessable 122-bit UUID compared against storage this
		// object alone reads, so equality is the whole check.
		if (!meta || meta.secret !== secret || Date.now() - meta.at > STAGED_TTL_MS) {
			return new Response("no staging answers to this address", { status: 404 });
		}
		if (meta.sealed || meta.chunks > 0) {
			return new Response("this staging already holds data", { status: 409 });
		}
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedBody(request, MAX_RAW_UPLOAD_BYTES);
		} catch (error: unknown) {
			if (error instanceof BodyTooLarge) {
				return new Response(`the upload exceeds ${MAX_RAW_UPLOAD_BYTES} bytes`, { status: 413 });
			}
			throw error;
		}
		const encoded = bytesToB64(bytes);
		const chunks = Math.ceil(encoded.length / STAGED_CHUNK_CHARS);
		for (let i = 0; i < chunks; i++) {
			await this.ctx.storage.put(
				`staged:${stagingId}:chunk:${i}`,
				encoded.slice(i * STAGED_CHUNK_CHARS, (i + 1) * STAGED_CHUNK_CHARS),
			);
		}
		await this.ctx.storage.put(`staged:${stagingId}`, {
			...meta,
			sealed: true,
			chunks,
			encodedLength: encoded.length,
			padding: encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0,
		} satisfies StagedMeta);
		return Response.json({
			stagingId,
			filename: meta.filename,
			contentType: meta.contentType,
			size: bytes.length,
		});
	}

	// Sweeps stagings past their lifetime and reports how much the live ones
	// hold, which is what bounds the store as a whole.
	private async sweepStaged(): Promise<number> {
		const entries = await this.ctx.storage.list<StagedMeta>({ prefix: "staged:" });
		const dead: string[] = [];
		let liveChars = 0;
		for (const [key, meta] of entries) {
			if (key.includes(":chunk:")) continue;
			if (Date.now() - meta.at > STAGED_TTL_MS) {
				dead.push(key);
				for (let i = 0; i < meta.chunks; i++) dead.push(`${key}:chunk:${i}`);
			} else {
				liveChars += meta.encodedLength;
			}
		}
		// A delete takes at most 128 keys at a time.
		for (let i = 0; i < dead.length; i += 128) {
			await this.ctx.storage.delete(dead.slice(i, i + 128));
		}
		return liveChars;
	}

	private async stagedMeta(stagingId: string): Promise<StagedMeta> {
		const meta = await this.ctx.storage.get<StagedMeta>(`staged:${stagingId}`);
		if (!meta || Date.now() - meta.at > STAGED_TTL_MS) {
			throw new Error(
				`no staged attachment ${stagingId}; stage_attachment_begin starts one, and a staging lasts ${STAGED_TTL_MS / 3_600_000} hours`,
			);
		}
		return meta;
	}

	private async stagedContent(
		stagingId: string,
	): Promise<{ filename: string; contentType: string; content: string }> {
		const meta = await this.stagedMeta(stagingId);
		if (!meta.sealed) {
			throw new Error(
				`staged attachment ${stagingId} is not finished; stage_attachment_finish seals appended chunks, an upload seals itself`,
			);
		}
		const parts: string[] = [];
		for (let i = 0; i < meta.chunks; i++) {
			const chunk = await this.ctx.storage.get<string>(`staged:${stagingId}:chunk:${i}`);
			if (chunk === undefined) {
				throw new Error(`staged attachment ${stagingId} lost a chunk; stage the file again`);
			}
			parts.push(chunk);
		}
		return { filename: meta.filename, contentType: meta.contentType, content: parts.join("") };
	}

	// One part may bring its bytes inline or point at a staging, never both.
	private async resolveStaged(
		part: { content?: string | undefined; stagingId?: string | undefined },
		what: string,
	): Promise<{ filename: string; contentType: string; content: string } | null> {
		if (part.stagingId !== undefined && part.content !== undefined) {
			throw new Error(`${what} carries either content or stagingId, never both`);
		}
		if (part.stagingId !== undefined) return this.stagedContent(part.stagingId);
		if (part.content === undefined) {
			throw new Error(`${what} needs content or stagingId`);
		}
		return null;
	}

	private async resolveAttachments(parts: FilePartArg[] | undefined): Promise<FilePart[]> {
		return Promise.all(
			(parts ?? []).map(async (part) => {
				const staged = await this.resolveStaged(part, "an attachment");
				if (staged) {
					return {
						filename: part.filename ?? staged.filename,
						contentType: part.contentType ?? staged.contentType,
						content: staged.content,
					};
				}
				if (part.filename === undefined || part.contentType === undefined) {
					throw new Error("an attachment passed as content needs filename and contentType");
				}
				return {
					filename: part.filename,
					contentType: part.contentType,
					content: part.content ?? "",
				};
			}),
		);
	}

	private async resolveInlineImages(parts: InlineImageArg[] | undefined): Promise<InlineImage[]> {
		return Promise.all(
			(parts ?? []).map(async (part) => {
				const staged = await this.resolveStaged(part, "an inline image");
				if (staged) {
					return {
						cid: part.cid,
						contentType: part.contentType ?? staged.contentType,
						content: staged.content,
					};
				}
				if (part.contentType === undefined) {
					throw new Error("an inline image passed as content needs contentType");
				}
				return { cid: part.cid, contentType: part.contentType, content: part.content ?? "" };
			}),
		);
	}

	// Reads back the enclosed parts a rebuilt draft keeps. Failing is deliberate:
	// a rebuild that cannot read a file back would otherwise write a draft with
	// the file quietly gone, which the person editing has no way to notice until
	// the mail is sent without it.
	private async carryOver<R extends { attachmentId: string; data: string; size: number }, T>(
		m: GmailMessage,
		refs: R[],
		shape: (ref: R, content: string) => T,
	): Promise<T[]> {
		// Counted the way the builder counts before any bytes move, so a draft
		// too heavy to rebuild is refused up front rather than part-way through.
		const total = refs.reduce((sum, ref) => sum + encodedSize(ref.size), 0);
		if (total > MAX_ENCODED_ATTACHMENT_BYTES) {
			throw new Error(
				"this draft carries more attachment data than an update can carry over; pass attachments explicitly or edit it in a mail client",
			);
		}
		const out: T[] = [];
		for (const ref of refs) {
			try {
				const data = ref.attachmentId
					? ((
							await this.api<AttachmentBody>(
								`/messages/${encodeURIComponent(m.id ?? "")}/attachments/${encodeURIComponent(ref.attachmentId)}`,
							)
						)?.data ?? "")
					: ref.data;
				out.push(shape(ref, b64urlToStandard(data)));
			} catch (error: unknown) {
				throw new Error(
					`a file already on this draft could not be read back, so nothing was changed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		return out;
	}

	// The files a rebuilt draft goes out with: the caller's own list when one
	// was passed, and otherwise whatever the draft already carries.
	private async keptFiles(
		m: GmailMessage,
		attachments: FilePartArg[] | undefined,
	): Promise<FilePart[]> {
		if (attachments !== undefined) return this.resolveAttachments(attachments);
		return this.carryOver(m, draftContentParts(m.payload).files, (ref, content) => ({
			filename: ref.filename,
			contentType: ref.contentType,
			content,
		}));
	}

	// An image is shown by the HTML that names its cid, so it lives and dies
	// with that rendering: dropping the HTML drops the images, and images
	// passed explicitly are the caller's to pair with their own HTML.
	private async keptImages(
		m: GmailMessage,
		inlineImages: InlineImageArg[] | undefined,
		htmlBody: string | undefined,
	): Promise<InlineImage[]> {
		if (inlineImages !== undefined) return this.resolveInlineImages(inlineImages);
		if (htmlBody === undefined) return [];
		return this.carryOver(m, draftContentParts(m.payload).inline, (ref, content) => ({
			cid: ref.cid,
			contentType: ref.contentType,
			content,
		}));
	}

	// A caller aiming to reply often has the Gmail message id to hand rather than
	// the Message-ID header, and the two are not interchangeable: the API id in
	// In-Reply-To produces a header no receiver can thread on, so the reply lands
	// as a new conversation. Look the header up when that is what arrived.
	private async threadHeaderFor(inReplyTo: string): Promise<string> {
		const direct = normalizeMessageId(inReplyTo);
		if (direct) return direct;
		const m = await this.api<GmailMessage & { name?: string; messages?: GmailMessage[] }>(
			`/messages/${encodeURIComponent(inReplyTo)}?format=metadata&metadataHeaders=Message-ID`,
		);
		const resolved = headerValue(m, "Message-ID");
		const normalized = resolved ? normalizeMessageId(resolved) : null;
		if (!normalized) {
			throw new Error(
				`message ${inReplyTo} carries no Message-ID header to reply to; pass the Message-ID header value as inReplyTo`,
			);
		}
		return normalized;
	}

	private text(data: unknown) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		};
	}

	// Everything a reply is built from, derived once from the message being
	// answered: who it goes to and from, the subject, the threading headers, and
	// the original's text as quotable blocks. reply_all sends it at once; a reply
	// draft holds it for editing. Both derive it here, or a draft later sent
	// would thread differently from a reply sent directly.
	private async replyContext(messageId: string): Promise<{
		original: GmailMessage;
		to: string[];
		cc: string[];
		from: string | undefined;
		subject: string;
		inReplyTo: string | undefined;
		references: string | undefined;
		quotedPlain: string;
		quotedHtml: string;
	}> {
		const account = (await this.ownerProps()).email;
		const original = await this.api<GmailMessage>(
			`/messages/${encodeURIComponent(messageId)}?format=full`,
		);
		// Mail to a send-as alias is mail to this account. Without them the
		// alias looks like a stranger: the reply copies it back to the
		// sender and goes out from the primary address, naming an identity
		// the correspondent was never given.
		const self = [account.toLowerCase(), ...(await this.sendAsAddresses())];
		const fromAddrs = parseAddresses(headerValue(original, "From"));
		const toAddrs = parseAddresses(headerValue(original, "To"));
		const ccAddrs = parseAddresses(headerValue(original, "Cc"));
		const replyToHeader = parseAddresses(headerValue(original, "Reply-To"));

		const { to, cc } = replyRecipients({
			self,
			from: fromAddrs,
			to: toAddrs,
			cc: ccAddrs,
			replyTo: replyToHeader,
		});

		// Answer from the identity the correspondent wrote to. Gmail sends
		// as the primary address when none is given, which would hand them
		// an address they were never given.
		const written = new Set([...toAddrs, ...ccAddrs].map(canonicalAddress));
		const spokenTo = self.find((identity) => written.has(canonicalAddress(identity)));
		const from =
			spokenTo && canonicalAddress(spokenTo) !== canonicalAddress(account) ? spokenTo : undefined;

		// A sender that omitted the angle brackets would otherwise have its
		// malformed id copied into the reply, where no receiver can thread
		// on it. Nothing usable means no threading header at all; the
		// thread id still carries the reply into the conversation.
		const originalMessageId = headerValue(original, "Message-ID");
		const messageIdHeader = originalMessageId ? normalizeMessageId(originalMessageId) : null;
		const references = sanitizeReferences(headerValue(original, "References"), messageIdHeader);
		const fromDisplay = decodeEncodedWords(headerValue(original, "From") ?? "unknown sender");
		const date = headerValue(original, "Date") ?? "an earlier date";
		const quoted = truncate(await this.messageBody(original), THREAD_BODY_LIMIT);

		return {
			original,
			to,
			cc,
			from,
			subject: replySubject(decodeEncodedWords(headerValue(original, "Subject") ?? "")),
			inReplyTo: messageIdHeader ?? undefined,
			references,
			quotedPlain: quotePlain(fromDisplay, date, quoted),
			quotedHtml: quoteHtml(fromDisplay, date, quoted),
		};
	}

	// A reply as a draft: the same derivation reply_all sends, held for editing.
	private async createReplyDraft({
		replyToMessageId,
		quote,
		to,
		subject,
		body,
		htmlBody,
		cc,
		bcc,
		from,
		attachments,
		inlineImages,
	}: {
		replyToMessageId: string;
		quote: boolean;
		to?: string | undefined;
		subject?: string | undefined;
		body: string;
		htmlBody?: string | undefined;
		cc?: string | undefined;
		bcc?: string | undefined;
		from?: string | undefined;
		attachments: FilePartArg[] | undefined;
		inlineImages: InlineImageArg[] | undefined;
	}) {
		const reply = await this.replyContext(replyToMessageId);
		// A caller that names its own recipients owns all of them: mixing a
		// written To with a derived Cc would copy people the caller chose to
		// leave out.
		const derived = to === undefined;
		const finalTo = derived ? reply.to.join(", ") : to;
		if (!finalTo.trim() && !cc?.trim() && !bcc?.trim()) {
			throw new Error("this reply has no recipient other than this account; pass to explicitly");
		}
		const raw = b64urlEncode(
			buildRfc822({
				to: finalTo,
				cc: derived ? (reply.cc.length > 0 ? reply.cc.join(", ") : undefined) : cc,
				bcc,
				from: from ?? reply.from,
				subject: subject ?? reply.subject,
				body: quote ? `${body}\n\n${reply.quotedPlain}` : body,
				htmlBody: htmlBody && quote ? `${htmlBody}\n<br>\n${reply.quotedHtml}` : htmlBody,
				attachments: await this.resolveAttachments(attachments),
				inlineImages: await this.resolveInlineImages(inlineImages),
				inReplyTo: reply.inReplyTo,
				references: reply.references,
			}),
		);
		// Gmail threads a draft on the thread id it is created with; the
		// headers alone are for every other mail client reading the thread.
		const d = await this.api<DraftResult>("/drafts", {
			method: "POST",
			body: JSON.stringify({ message: { raw, threadId: reply.original.threadId } }),
		});
		return this.text({
			draftId: d.id,
			messageId: d.message?.id,
			threadId: d.message?.threadId,
			to: finalTo,
		});
	}

	async init() {
		// Starting is what binds props for the life of the object, so a grant
		// that does not own this session must not be the one to do it. Refusing
		// leaves the object uninitialised and the owner's next request starts it
		// with their own grant, rather than every call failing until eviction.
		const account = (await this.ownerProps()).email;

		this.server.tool(
			"whoami",
			`Show which Gmail account this connection is bound to (${account})`,
			{},
			async () => this.text(await this.api("/profile")),
		);

		this.server.tool(
			"search_messages",
			`Search mail in ${account} with Gmail query syntax (from:, to:, subject:, is:unread, newer_than:7d, ...)`,
			{
				query: z.string().describe("Gmail search query"),
				maxResults: z.number().int().min(1).max(50).default(10),
				pageToken: z.string().optional().describe("nextPageToken from a previous search"),
			},
			async ({ query, maxResults, pageToken }) => {
				const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
				if (pageToken) params.set("pageToken", pageToken);
				const list = await this.api<MessageList>(`/messages?${params}`);
				const ids = (list.messages ?? []).map((m) => m.id ?? "").filter(Boolean);
				const messages = await this.mapLimited(ids, 8, (id) =>
					this.api<GmailMessage>(
						`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
					),
				);
				return this.text({
					resultSizeEstimate: list.resultSizeEstimate,
					nextPageToken: list.nextPageToken,
					// A message that vanished between the listing and the fetch is
					// reported in place rather than failing the whole search.
					messages: messages.map((m) => ("error" in m ? m : summarizeMessage(m))),
				});
			},
		);

		this.server.tool(
			"get_message",
			`Read a full message from ${account}, including decoded body text`,
			{ messageId: z.string() },
			async ({ messageId }) => {
				const m = await this.api<GmailMessage>(
					`/messages/${encodeURIComponent(messageId)}?format=full`,
				);
				return this.text({
					...summarizeMessage(m),
					messageIdHeader: headerValue(m, "Message-ID"),
					body: truncate(await this.messageBody(m), BODY_LIMIT),
					attachments: collectAttachments(m.payload).map(describeAttachment),
				});
			},
		);

		this.server.tool(
			"get_thread",
			`Read a conversation thread from ${account}. Bodies share a total budget, so long threads come back summarized — read individual messages with get_message`,
			{
				threadId: z.string(),
				includeBodies: z
					.boolean()
					.default(true)
					.describe("false returns headers and snippets only"),
				maxMessages: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(10)
					.describe("Newest messages are kept when a thread exceeds this"),
			},
			async ({ threadId, includeBodies, maxMessages }) => {
				// A metadata read returns every header of every message — Received
				// chains, DKIM and ARC signatures, List-* — where five are read.
				// Naming them turns a long thread from megabytes into kilobytes,
				// which is what makes this the escape hatch the size error promises.
				const threadQuery = includeBodies
					? "format=full"
					: `format=metadata${SUMMARY_HEADERS.map((h) => `&metadataHeaders=${h}`).join("")}`;
				let all: GmailMessage[];
				let kept: GmailMessage[];
				try {
					const t = await this.api<{ messages?: GmailMessage[] }>(
						`/threads/${encodeURIComponent(threadId)}?${threadQuery}`,
					);
					all = t.messages ?? [];
					kept = all.slice(-maxMessages);
				} catch (e) {
					if (!(e instanceof GmailApiError) || e.status !== 413) throw e;
					// One read of a thread returns every message whatever was asked
					// for, so a long one can be too large to answer at all. Asking
					// for the ids alone is a few tens of bytes each, and the window
					// that was wanted is then fetched a message at a time.
					const ids = await this.api<{ messages?: { id?: string }[] }>(
						`/threads/${encodeURIComponent(threadId)}?format=minimal&fields=messages/id`,
					);
					all = ids.messages ?? [];
					const window = all.slice(-maxMessages);
					const fetched = await this.mapLimited(window, 4, (m) =>
						this.api<GmailMessage>(
							`/messages/${encodeURIComponent(m.id ?? "")}?${includeBodies ? "format=full" : threadQuery}`,
						),
					);
					kept = fetched.filter((m): m is GmailMessage => !("error" in m));
				}
				const omitted = all.length - kept.length;

				if (!includeBodies) {
					return this.text({
						messageCount: all.length,
						omitted,
						messages: kept.map(summarizeMessage),
					});
				}

				// One budget for the whole thread, split evenly, so a single long
				// message cannot crowd out the rest and the total stays bounded
				// however many messages were requested.
				const perMessage = Math.floor(THREAD_TOTAL_BUDGET / Math.max(kept.length, 1));
				const messages = await this.mapLimited(kept, 4, async (m) => ({
					...summarizeMessage(m),
					body: truncate(await this.messageBody(m), Math.min(perMessage, THREAD_BODY_LIMIT)),
				}));
				return this.text({ messageCount: all.length, omitted, messages });
			},
		);

		this.server.tool("list_labels", `List labels in ${account}`, {}, async () => {
			const l = await this.api<LabelList>("/labels");
			return this.text((l.labels ?? []).map((x) => ({ id: x.id, name: x.name, type: x.type })));
		});

		this.server.tool(
			"modify_labels",
			`Add or remove labels on a message in ${account} (also archives: remove INBOX; marks read: remove UNREAD)`,
			{
				messageId: z.string(),
				addLabelIds: z.array(z.string()).default([]),
				removeLabelIds: z.array(z.string()).default([]),
			},
			async ({ messageId, addLabelIds, removeLabelIds }) => {
				// The modify/trash responses carry no payload, so headers would be
				// empty; report the label state that actually changed.
				const m = await this.api(`/messages/${encodeURIComponent(messageId)}/modify`, {
					method: "POST",
					body: JSON.stringify({ addLabelIds, removeLabelIds }),
				});
				return this.text({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
			},
		);

		this.server.tool(
			"trash_message",
			`Move a message to the trash in ${account} (reversible for 30 days)`,
			{ messageId: z.string() },
			async ({ messageId }) => {
				const m = await this.api(`/messages/${encodeURIComponent(messageId)}/trash`, {
					method: "POST",
				});
				return this.text({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
			},
		);

		const draftFields = {
			to: z.string(),
			subject: z.string(),
			body: z.string().describe("Plain-text body"),
			htmlBody: z.string().optional().describe("HTML alternative shown by rich clients"),
			cc: z.string().optional(),
			bcc: z.string().optional(),
			from: z.string().optional().describe("Send-as alias already configured in the account"),
			attachments: z.array(filePartSchema).default([]),
			inlineImages: z.array(inlineImageSchema).default([]),
		};

		this.server.tool(
			"create_draft",
			`Create a draft in ${account} without sending. With replyToMessageId the draft joins that message's thread, carries its threading headers, and derives recipients and subject from a reply-all when they are not given`,
			{
				...draftFields,
				to: z.string().optional().describe("Required unless replyToMessageId derives it"),
				subject: z.string().optional().describe("Required unless replyToMessageId derives it"),
				replyToMessageId: z
					.string()
					.optional()
					.describe("Gmail message id of the message this draft answers"),
				quote: z
					.boolean()
					.default(true)
					.describe("When replying, quote the original under the body"),
			},
			async ({ replyToMessageId, quote, to, subject, body, ...rest }) => {
				if (replyToMessageId) {
					return this.createReplyDraft({ replyToMessageId, quote, to, subject, body, ...rest });
				}
				if (to === undefined || subject === undefined) {
					throw new Error(
						"a fresh draft needs to and subject; a reply derives them from replyToMessageId",
					);
				}
				const raw = b64urlEncode(
					buildRfc822({
						to,
						subject,
						body,
						...rest,
						attachments: await this.resolveAttachments(rest.attachments),
						inlineImages: await this.resolveInlineImages(rest.inlineImages),
					}),
				);
				const d = await this.api<DraftResult>("/drafts", {
					method: "POST",
					body: JSON.stringify({ message: { raw } }),
				});
				return this.text({ draftId: d.id, messageId: d.message?.id });
			},
		);

		this.server.tool(
			"update_draft",
			`Change parts of a draft in ${account}. Whatever is not passed keeps its current value — recipients, subject, text, files added in any client, and the thread the draft answers all survive the rebuild`,
			{
				draftId: z.string(),
				to: z.string().optional(),
				subject: z.string().optional(),
				body: z
					.string()
					.optional()
					.describe("Plain-text body; passing it replaces the readable text as a whole"),
				htmlBody: z
					.string()
					.optional()
					.describe("HTML alternative shown by rich clients; needs body beside it"),
				cc: z.string().optional(),
				bcc: z.string().optional(),
				from: z.string().optional().describe("Send-as alias already configured in the account"),
				attachments: z
					.array(filePartSchema)
					.optional()
					.describe("Omit to keep the draft's files; [] removes them"),
				inlineImages: z
					.array(inlineImageSchema)
					.optional()
					.describe("Omit to keep the images the draft's HTML shows; [] removes them"),
			},
			async ({
				draftId,
				to,
				subject,
				body,
				htmlBody,
				cc,
				bcc,
				from,
				attachments,
				inlineImages,
			}) => {
				const current = await this.api<DraftResult>(
					`/drafts/${encodeURIComponent(draftId)}?format=full`,
				);
				const m = current.message ?? {};
				// Headers went out encoded and come back encoded; the builder encodes
				// again, so they have to be read back to text first.
				const existing = (name: string) => {
					const value = headerValue(m, name);
					return value === undefined ? undefined : decodeEncodedWords(value);
				};

				// The readable text is one unit in two renderings. Replacing only one
				// of them would leave the other saying what the draft used to say, and
				// which one a recipient reads depends on their mail client.
				if (htmlBody !== undefined && body === undefined) {
					throw new Error("htmlBody replaces the readable text and needs body beside it");
				}
				const text =
					body !== undefined
						? { body, htmlBody }
						: {
								body: await this.messageBody(m),
								htmlBody: extractHtmlBody(m.payload) || undefined,
							};

				const files = await this.keptFiles(m, attachments);
				const images = await this.keptImages(m, inlineImages, text.htmlBody);

				// The rebuilt message replaces the old one wholesale, so the threading
				// state has to travel too or a reply draft comes out of the update as
				// a fresh conversation.
				const inReplyTo = normalizeMessageId(headerValue(m, "In-Reply-To") ?? "") ?? undefined;
				const references = sanitizeReferences(headerValue(m, "References"));

				const raw = b64urlEncode(
					buildRfc822({
						to: to ?? existing("To") ?? "",
						cc: cc ?? existing("Cc"),
						bcc: bcc ?? existing("Bcc"),
						from: from ?? existing("From"),
						subject: subject ?? existing("Subject") ?? "",
						body: text.body,
						htmlBody: text.htmlBody,
						attachments: files,
						inlineImages: images,
						inReplyTo,
						references,
					}),
				);
				const d = await this.api<DraftResult>(`/drafts/${encodeURIComponent(draftId)}`, {
					method: "PUT",
					body: JSON.stringify({
						message: { raw, ...(m.threadId ? { threadId: m.threadId } : {}) },
					}),
				});
				return this.text({
					draftId: d.id,
					messageId: d.message?.id,
					threadId: d.message?.threadId,
					attachments: files.map((f) => f.filename),
				});
			},
		);

		this.server.tool(
			"send_draft",
			`Send an existing draft from ${account}`,
			{ draftId: z.string() },
			async ({ draftId }) => {
				const m = await this.api("/drafts/send", {
					method: "POST",
					body: JSON.stringify({ id: draftId }),
				});
				return this.text({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
			},
		);

		this.server.tool(
			"delete_draft",
			`Delete a draft in ${account} permanently (drafts have no trash)`,
			{ draftId: z.string() },
			async ({ draftId }) => {
				await this.api(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
				return this.text({ deleted: draftId });
			},
		);

		this.server.tool(
			"list_drafts",
			`List drafts in ${account}`,
			{
				maxResults: z.number().int().min(1).max(50).default(10),
				pageToken: z.string().optional().describe("nextPageToken from a previous listing"),
			},
			async ({ maxResults, pageToken }) => {
				// Without a page token the drafts past the first page cannot be
				// reached at all: the listing is the only place their ids appear.
				const draftParams = new URLSearchParams({ maxResults: String(maxResults) });
				if (pageToken) draftParams.set("pageToken", pageToken);
				const l = await this.api<DraftList & { nextPageToken?: string }>(`/drafts?${draftParams}`);
				const drafts = l.drafts ?? [];
				// The list response carries ids only, which say nothing about which
				// draft is which; pull the headers that identify them.
				const detailed = await this.mapLimited(drafts, 8, async (d) => {
					const full = await this.api<{ message?: GmailMessage }>(
						`/drafts/${encodeURIComponent(d.id ?? "")}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
					);
					return {
						draftId: d.id,
						messageId: full.message?.id,
						to: headerValue(full.message, "To"),
						subject: headerValue(full.message, "Subject"),
						date: headerValue(full.message, "Date"),
						snippet: full.message?.snippet,
					};
				});
				return this.text({ nextPageToken: l.nextPageToken, drafts: detailed });
			},
		);

		this.server.tool(
			"stage_attachment_begin",
			`Stage a file for ${account} outside tool arguments, for attachments whose base64 is too large to pass inline. Then either PUT the raw file bytes to the returned uploadUrl (curl -T <file> '<uploadUrl>'), which finishes the staging by itself, or send base64 with stage_attachment_append and seal it with stage_attachment_finish. Any attachments or inlineImages field then accepts {"stagingId": ...}`,
			{
				filename: z.string(),
				contentType: z.string().describe("Media type, e.g. application/pdf"),
			},
			async ({ filename, contentType }) => {
				await this.assertSessionOwner();
				await this.assertWithinRate();
				// Refused here, before any bytes move: the builder would refuse the
				// finished attachment anyway, and later is after the upload.
				if (/[\r\n\0]/.test(filename)) {
					throw new Error("filename contains a line break or NUL");
				}
				if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
					throw new Error(`invalid content type: ${contentType}`);
				}
				const held = await this.sweepStaged();
				if (held > MAX_STAGED_TOTAL_CHARS) {
					throw new Error(
						"the staging store is full; attach what is already staged or wait for it to expire",
					);
				}
				const stagingId = crypto.randomUUID();
				const meta: StagedMeta = {
					filename,
					contentType,
					secret: crypto.randomUUID(),
					at: Date.now(),
					sealed: false,
					chunks: 0,
					encodedLength: 0,
					padding: 0,
				};
				await this.ctx.storage.put(`staged:${stagingId}`, meta);
				const name = this.ctx.id.name;
				const uploadUrl =
					this.origin && name
						? `${this.origin}/upload/${encodeURIComponent(name)}/${stagingId}/${meta.secret}`
						: undefined;
				return this.text({
					stagingId,
					uploadUrl,
					expiresAt: new Date(meta.at + STAGED_TTL_MS).toISOString(),
					next: uploadUrl
						? "PUT the raw file bytes to uploadUrl, or append base64 with stage_attachment_append and call stage_attachment_finish"
						: "append base64 with stage_attachment_append, then call stage_attachment_finish",
				});
			},
		);

		this.server.tool(
			"stage_attachment_append",
			`Add base64 to a staged attachment in ${account}, in order, up to ${MAX_APPEND_CHARS} characters per call`,
			{
				stagingId: z.string(),
				content: z
					.string()
					.describe("Standard base64; every chunk before the last must carry no padding"),
			},
			async ({ stagingId, content }) => {
				await this.assertSessionOwner();
				await this.assertWithinRate();
				const meta = await this.stagedMeta(stagingId);
				if (meta.sealed) {
					throw new Error("this staging is already finished; begin a new one to replace it");
				}
				if (meta.padding > 0) {
					throw new Error("an earlier chunk ended with padding, which closes the file");
				}
				const cleaned = content.replace(/\s+/g, "");
				if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
					throw new Error("content must be standard base64 in whole four-character groups");
				}
				if (cleaned.length > MAX_APPEND_CHARS) {
					throw new Error(`append at most ${MAX_APPEND_CHARS} characters per call`);
				}
				if (meta.encodedLength + cleaned.length > MAX_ENCODED_ATTACHMENT_BYTES) {
					throw new Error(
						`this file would exceed the ${MAX_ENCODED_ATTACHMENT_BYTES}-character ceiling a message can carry`,
					);
				}
				await this.ctx.storage.put(`staged:${stagingId}:chunk:${meta.chunks}`, cleaned);
				const next: StagedMeta = {
					...meta,
					chunks: meta.chunks + 1,
					encodedLength: meta.encodedLength + cleaned.length,
					padding: (cleaned.match(/=/g) ?? []).length,
				};
				await this.ctx.storage.put(`staged:${stagingId}`, next);
				return this.text({ stagingId, encodedLength: next.encodedLength });
			},
		);

		this.server.tool(
			"stage_attachment_finish",
			`Seal a staged attachment in ${account} so messages and drafts can attach it by stagingId`,
			{ stagingId: z.string() },
			async ({ stagingId }) => {
				await this.assertSessionOwner();
				await this.assertWithinRate();
				const meta = await this.stagedMeta(stagingId);
				const sealed = meta.sealed ? meta : { ...meta, sealed: true };
				if (!meta.sealed) {
					await this.ctx.storage.put(`staged:${stagingId}`, sealed);
				}
				return this.text({
					stagingId,
					filename: sealed.filename,
					contentType: sealed.contentType,
					size: (sealed.encodedLength / 4) * 3 - sealed.padding,
					expiresAt: new Date(sealed.at + STAGED_TTL_MS).toISOString(),
				});
			},
		);

		this.server.tool(
			"send_message",
			`Send mail as ${account}. For replies pass threadId plus the original's Message-ID header, or its Gmail message id, as inReplyTo`,
			{
				...draftFields,
				threadId: z.string().optional(),
				inReplyTo: z
					.string()
					.optional()
					.describe(
						"Message-ID header value of the message being replied to; a Gmail message id is resolved to it",
					),
			},
			async ({
				to,
				subject,
				body,
				htmlBody,
				cc,
				bcc,
				from,
				attachments,
				inlineImages,
				threadId,
				inReplyTo,
			}) => {
				// Gmail places a message in a thread only when the threading headers
				// agree with the thread id; one without the other produces a message
				// that either is refused or starts its own conversation.
				if (threadId && !inReplyTo) {
					throw new Error(
						"replying into a thread needs inReplyTo as well as threadId; pass the original's Message-ID",
					);
				}
				const threadHeader = inReplyTo ? await this.threadHeaderFor(inReplyTo) : undefined;
				const raw = b64urlEncode(
					buildRfc822({
						to,
						cc,
						bcc,
						from,
						subject,
						body,
						htmlBody,
						attachments: await this.resolveAttachments(attachments),
						inlineImages: await this.resolveInlineImages(inlineImages),
						inReplyTo: threadHeader,
						references: threadHeader,
					}),
				);
				const m = await this.api("/messages/send", {
					method: "POST",
					body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
				});
				return this.text({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
			},
		);

		this.server.tool(
			"reply_all",
			`Reply to a message in ${account}, addressing every original recipient except this account, with the original quoted`,
			{
				messageId: z.string().describe("The message being replied to"),
				body: z.string().describe("Plain-text reply, without quoted history"),
				htmlBody: z.string().optional().describe("HTML reply, without quoted history"),
				attachments: z.array(filePartSchema).default([]),
				inlineImages: z.array(inlineImageSchema).default([]),
			},
			async ({ messageId, body, htmlBody, attachments, inlineImages }) => {
				const reply = await this.replyContext(messageId);
				if (reply.to.length === 0) {
					throw new Error("reply_all found no recipient other than this account");
				}
				const raw = b64urlEncode(
					buildRfc822({
						to: reply.to.join(", "),
						cc: reply.cc.length > 0 ? reply.cc.join(", ") : undefined,
						from: reply.from,
						subject: reply.subject,
						body: `${body}\n\n${reply.quotedPlain}`,
						htmlBody: htmlBody ? `${htmlBody}\n<br>\n${reply.quotedHtml}` : undefined,
						attachments: await this.resolveAttachments(attachments),
						inlineImages: await this.resolveInlineImages(inlineImages),
						inReplyTo: reply.inReplyTo,
						references: reply.references,
					}),
				);
				const m = await this.api("/messages/send", {
					method: "POST",
					body: JSON.stringify({ raw, threadId: reply.original.threadId }),
				});
				return this.text({ id: m.id, threadId: m.threadId, to: reply.to, cc: reply.cc });
			},
		);

		this.server.tool(
			"forward_message",
			`Forward a message from ${account}, quoting the original above its own headers`,
			{
				messageId: z.string().describe("The message being forwarded"),
				to: z.string(),
				cc: z.string().optional(),
				body: z.string().default("").describe("Your own note above the forwarded content"),
				htmlBody: z.string().optional(),
				includeAttachments: z
					.boolean()
					.default(false)
					.describe("Re-attach the original's files, within the attachment size budget"),
			},
			async ({ messageId, to, cc, body, htmlBody, includeAttachments }) => {
				const original = await this.api<GmailMessage>(
					`/messages/${encodeURIComponent(messageId)}?format=full`,
				);
				const fields = {
					// This block is body text the recipient reads, so the headers go in
					// as words rather than as their encoding.
					from: decodeEncodedWords(headerValue(original, "From") ?? ""),
					date: headerValue(original, "Date"),
					subject: decodeEncodedWords(headerValue(original, "Subject") ?? ""),
					to: decodeEncodedWords(headerValue(original, "To") ?? ""),
					cc: decodeEncodedWords(headerValue(original, "Cc") ?? ""),
				};
				// A forward carries the message itself, not a quotation of it, and
				// the person it reaches has no other copy to fall back on. The
				// thread budget is the wrong one here: it exists for quoted
				// history, where the reader already holds the original.
				const originalBody = truncate(await this.messageBody(original), BODY_LIMIT);

				const own = collectAttachments(original.payload).filter((a) => !a.enclosed);
				const carried = own.filter((a) => a.size <= ATTACHMENT_BYTE_LIMIT);
				const skipped = own.filter((a) => a.size > ATTACHMENT_BYTE_LIMIT).map((a) => a.filename);
				let carriedBytes = 0;
				const fetched = includeAttachments
					? await this.mapLimited(carried, 4, async (a) => {
							// The builder's ceiling is reached only once everything is in
							// memory, which for a forward is far too late: these bytes come
							// from Gmail rather than from the caller.
							// Counted the way the builder counts, so what passes here is
							// what it will accept rather than a different figure.
							carriedBytes += encodedSize(a.size);
							if (carriedBytes > MAX_ENCODED_ATTACHMENT_BYTES) {
								throw new Error(
									"this message carries more attachment data than can be forwarded; forward it from a mail client",
								);
							}
							// Which store the bytes are in is told by the id, not by
							// whether there are any: an empty file has none either way,
							// and asking Gmail for it under a blank id is a 404.
							const blob = a.attachmentId
								? await this.api<AttachmentBody>(
										`/messages/${encodeURIComponent(original.id ?? "")}/attachments/${encodeURIComponent(a.attachmentId)}`,
									)
								: { data: a.data };
							return {
								filename: a.filename,
								contentType: a.mimeType,
								// Gmail hands back base64url; the builder wants standard base64.
								content: b64urlToStandard(blob?.data ?? ""),
							};
						})
					: [];
				// A forward that quietly drops an attachment is worse than one that
				// does not go: the recipient cannot tell what is missing.
				const failed = fetched.find((a) => "error" in a);
				if (failed && "error" in failed) {
					throw new Error(`an attachment could not be read: ${failed.error}`);
				}
				const attachments = fetched.filter(
					(a): a is { filename: string; contentType: string; content: string } => !("error" in a),
				);

				const raw = b64urlEncode(
					buildRfc822({
						to,
						cc,
						subject: forwardSubject(fields.subject),
						body: `${body}\n\n${forwardHeaderBlock(fields)}\n\n${originalBody}`,
						htmlBody: htmlBody
							? `${htmlBody}\n<br>\n${forwardHtmlBlock({ ...fields, body: originalBody })}`
							: undefined,
						attachments,
					}),
				);
				const m = await this.api("/messages/send", {
					method: "POST",
					body: JSON.stringify({ raw }),
				});
				return this.text({
					id: m.id,
					threadId: m.threadId,
					attachmentsForwarded: attachments.length,
					...(includeAttachments && skipped.length > 0 ? { skippedTooLarge: skipped } : {}),
				});
			},
		);

		this.server.tool(
			"get_attachment",
			`Download an attachment from a message in ${account}. Returns base64 while it stays small enough to read; text types come back decoded`,
			{
				messageId: z.string(),
				attachmentId: z
					.string()
					.describe("From the message listing; Gmail reissues it on every read"),
				filename: z
					.string()
					.optional()
					.describe("Names the attachment when a message carries more than one"),
				textOnly: z
					.boolean()
					.default(false)
					.describe("Return only decoded text for text/* attachments, no base64"),
			},
			async ({ messageId, attachmentId, filename, textOnly }) => {
				// The part's declared type decides whether decoding to text is
				// meaningful; decoding a PDF as UTF-8 would return pages of noise.
				const message = await this.api<GmailMessage>(
					`/messages/${encodeURIComponent(messageId)}?format=full`,
				);
				const parts = collectAttachments(message.payload);
				// Gmail hands out a different attachment id every time a message is
				// read, so the one a caller is holding came from an earlier read and
				// will not appear here. The filename survives between reads, and a
				// message carrying a single attachment leaves nothing to choose
				// between; the id is still tried first for the messages where it
				// does stay put.
				// The id is tried first: when it still matches there is nothing to be
				// ambiguous about, whatever names the other parts carry.
				// A part that arrived whole has no id of its own, and every one of
				// them is published with the same empty string. Matching on that
				// would answer with whichever came first and skip the check below.
				const byId = attachmentId ? parts.find((a) => a.attachmentId === attachmentId) : undefined;
				const named = filename ? parts.filter((a) => a.filename === filename) : [];
				if (!byId && named.length > 1) {
					throw new Error(
						`this message carries ${named.length} attachments named ${filename}; they cannot be told apart once Gmail has reissued their ids`,
					);
				}
				const part =
					byId ??
					named[0] ??
					// Naming a file that is not here is a mistake worth reporting; with
					// no name given and one attachment there is nothing to mistake.
					(filename === undefined && parts.length === 1 ? parts[0] : undefined);
				if (!part) {
					const names = parts.map((a) => a.filename).join(", ");
					throw new Error(
						names
							? `this message carries several attachments; name one of them with filename: ${names}`
							: "this message carries no attachments",
					);
				}
				if (part.size > ATTACHMENT_BYTE_LIMIT) {
					return this.text({
						filename: part.filename,
						mimeType: part.mimeType,
						size: part.size,
						error: `attachment is larger than the ${ATTACHMENT_BYTE_LIMIT}-byte budget; fetch it with a regular mail client`,
					});
				}

				// A part that arrived whole carries its own bytes; only an
				// externalised one has to be fetched, and which it is depends on
				// whether it has an id rather than on whether it has any bytes.
				const data: string = part.attachmentId
					? ((
							await this.api<AttachmentBody>(
								`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.attachmentId)}`,
							)
						)?.data ?? "")
					: part.data;
				const meta = { filename: part.filename, mimeType: part.mimeType, size: part.size };
				if (textOnly) {
					if (!part.mimeType?.startsWith("text/")) {
						return this.text({
							...meta,
							error: "textOnly applies to text/* attachments; omit it to receive base64",
						});
					}
					return this.text({
						...meta,
						text: truncate(decodeAttachmentText(data, part.mimeType, part.charset), BODY_LIMIT),
					});
				}
				if (data.length > ATTACHMENT_INLINE_LIMIT) {
					return this.text({
						...meta,
						error: `this attachment encodes to ${data.length} characters, past the ${ATTACHMENT_INLINE_LIMIT} this server returns inline; open it in a mail client`,
					});
				}
				// Handed straight back, this is base64url, which the send tools refuse.
				// Returning it in the form they accept makes the round trip work.
				return this.text({ ...meta, contentBase64: b64urlToStandard(data) });
			},
		);

		this.server.tool(
			"untrash_message",
			`Restore a message from the trash in ${account}`,
			{ messageId: z.string() },
			async ({ messageId }) => {
				const m = await this.api(`/messages/${encodeURIComponent(messageId)}/untrash`, {
					method: "POST",
				});
				return this.text({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
			},
		);

		this.server.tool(
			"modify_thread_labels",
			`Add or remove labels on every message of a thread in ${account}`,
			{
				threadId: z.string(),
				addLabelIds: z.array(z.string()).default([]),
				removeLabelIds: z.array(z.string()).default([]),
			},
			async ({ threadId, addLabelIds, removeLabelIds }) => {
				const t = await this.api<{ id?: string; messages?: GmailMessage[] }>(
					`/threads/${encodeURIComponent(threadId)}/modify`,
					{
						method: "POST",
						body: JSON.stringify({ addLabelIds, removeLabelIds }),
					},
				);
				return this.text({ id: t.id, messages: (t.messages ?? []).length });
			},
		);

		this.server.tool(
			"trash_thread",
			`Move a whole thread to the trash in ${account} (reversible for 30 days)`,
			{ threadId: z.string() },
			async ({ threadId }) => {
				const t = await this.api(`/threads/${encodeURIComponent(threadId)}/trash`, {
					method: "POST",
				});
				return this.text({ id: t.id, trashed: true });
			},
		);

		this.server.tool(
			"untrash_thread",
			`Restore a whole thread from the trash in ${account}`,
			{ threadId: z.string() },
			async ({ threadId }) => {
				const t = await this.api(`/threads/${encodeURIComponent(threadId)}/untrash`, {
					method: "POST",
				});
				return this.text({ id: t.id, trashed: false });
			},
		);

		this.server.tool(
			"batch_modify_messages",
			`Add or remove labels on up to 1000 messages of ${account} in one call (archive: remove INBOX; mark read: remove UNREAD)`,
			{
				messageIds: z.array(z.string()).min(1).max(1000),
				addLabelIds: z.array(z.string()).default([]),
				removeLabelIds: z.array(z.string()).default([]),
			},
			async ({ messageIds, addLabelIds, removeLabelIds }) => {
				await this.api("/messages/batchModify", {
					method: "POST",
					body: JSON.stringify({ ids: messageIds, addLabelIds, removeLabelIds }),
				});
				return this.text({ modified: messageIds.length, addLabelIds, removeLabelIds });
			},
		);

		this.server.tool(
			"create_label",
			`Create a label in ${account}`,
			{ name: z.string().describe("Nested labels use '/', e.g. Projects/Website") },
			async ({ name }) => {
				const l = await this.api("/labels", {
					method: "POST",
					body: JSON.stringify({
						name,
						labelListVisibility: "labelShow",
						messageListVisibility: "show",
					}),
				});
				return this.text({ id: l.id, name: l.name });
			},
		);

		this.server.tool(
			"update_label",
			`Rename a label in ${account}`,
			{ labelId: z.string(), name: z.string() },
			async ({ labelId, name }) => {
				const l = await this.api(`/labels/${encodeURIComponent(labelId)}`, {
					method: "PATCH",
					body: JSON.stringify({ name }),
				});
				return this.text({ id: l.id, name: l.name });
			},
		);

		this.server.tool(
			"delete_label",
			`Delete a label in ${account} (messages keep their other labels)`,
			{ labelId: z.string() },
			async ({ labelId }) => {
				await this.api(`/labels/${encodeURIComponent(labelId)}`, { method: "DELETE" });
				return this.text({ deleted: labelId });
			},
		);
	}
}

// What a listing says about an attachment. The bytes are deliberately not here:
// a message with three inline images would otherwise put a few hundred kilobytes
// of base64 into every read of it, beside a body that is capped at a fraction of
// that. They are fetched when they are asked for.
function describeAttachment(a: {
	enclosed: boolean;
	filename: string;
	mimeType: string;
	size: number;
	attachmentId: string;
	charset: string;
}) {
	return {
		filename: a.filename,
		mimeType: a.mimeType,
		size: a.size,
		attachmentId: a.attachmentId,
		charset: a.charset,
		// Only said when true, so an ordinary listing stays as it was.
		...(a.enclosed ? { insideForwardedMessage: true } : {}),
	};
}

function collectAttachments(payload: GmailPart | undefined) {
	const out: {
		enclosed: boolean;
		filename: string;
		mimeType: string;
		size: number;
		// Where the bytes are. Gmail externalises a large part and gives it an
		// id to fetch; a small one arrives whole in the listing, with no id at
		// all. Keeping only the first kind loses the second silently, and a
		// forward then goes out without the file.
		attachmentId: string;
		data: string;
		charset: string;
	}[] = [];
	const walk = (p: GmailPart | undefined, enclosed: boolean) => {
		if (!p) return;
		// A named part is an attachment whether or not it has bytes: an empty
		// file is one a sender attached, and judging by whether the data is
		// truthy drops it from the listing and out of a forward.
		if (p.filename && (p.body?.attachmentId !== undefined || p.body?.data !== undefined)) {
			out.push({
				enclosed,
				filename: p.filename,
				mimeType: p.mimeType ?? "application/octet-stream",
				size: p.body.size ?? 0,
				attachmentId: p.body.attachmentId ?? "",
				data: p.body.data ?? "",
				// A text attachment declares its own encoding, and decoding
				// ISO-2022-JP as UTF-8 returns replacement characters.
				charset: partCharset(p),
			});
		}
		// A message forwarded as a file brings its own attachments with it. They
		// are worth naming, so get_attachment can fetch one without pulling the
		// whole enclosure, but re-attaching them to a forward would send the
		// same file twice: once inside the enclosure and once beside it.
		const inside = enclosed || (p.mimeType ?? "").toLowerCase().startsWith("message/");
		for (const child of p.parts ?? []) walk(child, inside);
	};
	walk(payload, false);
	return out;
}

// One handler serves /mcp and every /mcp/<label> alias, so clients that dedupe
// servers by URL can hold one connection per Google account under freely chosen
// labels. The pattern must cover the aliases itself: the OAuth provider matches
// api routes by string prefix and dispatches to the first match, so a separate
// alias entry after "/mcp" would never be reached. Sessions are keyed by the
// Mcp-Session-Id header rather than the path, so aliases never share state.
// A session is a Durable Object addressed by the Mcp-Session-Id header alone,
// so without this the header would decide whose mailbox a request reaches. The
// account has to be settled out here: inside the object the transport reaches
// the agent through a request carrying the client's own headers, so nothing
// there distinguishes an authenticated account from a claimed one.
const mcpAgent = GmailMCP.serve("/mcp{/:label}?") as {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};

const mcpHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const email = (ctx.props as Props | undefined)?.email?.toLowerCase();
		// The transport copies the request's headers on to the session object, so
		// a client-supplied one would arrive there looking authenticated. It is
		// cleared first and the account stamped from the grant the OAuth layer
		// decrypted, which no client can choose.
		// The account is settled here rather than inside the object. Two reasons:
		// the transport tears a session down over RPC without ever calling its
		// fetch, and a response the object does return is read only for a
		// WebSocket — status and body are discarded, so a refusal raised there
		// reaches the client as an unexplained 500.
		const sessionId = request.headers.get("mcp-session-id");
		if (email && sessionId) {
			// The props go with it: reaching a cold object starts it, and starting
			// it builds the tool list from the account it belongs to. Without them
			// it wakes with no identity and fails before it can answer.
			const session = await getAgentByName<Env, GmailMCP>(
				env.MCP_OBJECT,
				`streamable-http:${sessionId}`,
				{ props: ctx.props as Record<string, unknown> },
			);
			if (!(await session.isOwnedBy(email))) {
				return new Response("this MCP session belongs to a different Google account", {
					status: 403,
				});
			}
		}

		const forwarded = new Request(request);
		forwarded.headers.delete(ACCOUNT_HEADER);
		// Its sibling: the framework reads a grant straight out of this header
		// when one is present. Nothing on this path sends it, and the grant the
		// object runs under is the one passed by name above, so a copy arriving
		// from a client is only ever an attempt to choose its own.
		forwarded.headers.delete(PROPS_HEADER);
		if (email) forwarded.headers.set(ACCOUNT_HEADER, email);
		return mcpAgent.fetch(forwarded, env, ctx);
	},
};

// The provider declares a handler as an ExportedHandler with a required fetch.
// Both of these supply one; the declarations do not line up with a plain object.
type ProviderHandler = { fetch: ExportedHandlerFetchHandler<unknown> };

const provider = new OAuthProvider({
	apiHandlers: {
		"/mcp": mcpHandler as unknown as ProviderHandler,
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as unknown as ProviderHandler,
	tokenEndpoint: "/token",
	// Registration is open to any client, so the code exchange must carry real
	// cryptographic proof: plain PKCE offers none.
	allowPlainPKCE: false,
});

// Both of these are open to anyone holding the URL, and the provider reads a
// whole body before it measures one: the token endpoint hands it to formData()
// with no ceiling, and registration compares Content-Length, which a chunked
// sender simply omits. What arrives is counted here instead, where refusing it
// costs nothing.
const OAUTH_BODY_LIMIT = 64 * 1024;
const BOUNDED_ENDPOINTS = new Set(["/token", "/register"]);

// What a POST to each path may carry. The MCP transport refuses an oversized
// message by its declared length, which a sender omits by streaming, so the
// same ceiling is applied to what actually arrives.
function bodyLimitFor(path: string): number | null {
	if (BOUNDED_ENDPOINTS.has(path)) return OAUTH_BODY_LIMIT;
	if (path === "/mcp" || path.startsWith("/mcp/")) return MCP_MESSAGE_LIMIT;
	return null;
}

// Carries a staged upload to the session that minted its URL. The path is the
// whole credential — session name, staging id, secret — and the session judges
// it; out here the body is only ever streamed through. The register limiter
// gates it because the two share a shape: no credentials up front, and each
// call wakes or writes something that costs the deployment.
async function uploadRoute(request: Request, env: Env, path: string): Promise<Response> {
	if (request.method !== "PUT") {
		return new Response("PUT the raw file bytes to an upload URL", { status: 405 });
	}
	const segments = path.split("/");
	const name = decodeURIComponent(segments[2] ?? "");
	if (segments.length !== 5 || !name) {
		return new Response("no staging answers to this address", { status: 404 });
	}
	if (env.REGISTER_LIMITER) {
		const caller = request.headers.get("cf-connecting-ip") ?? "unknown";
		const { success } = await env.REGISTER_LIMITER.limit({ key: caller });
		if (!success) {
			return new Response("Too many uploads", { status: 429 });
		}
	}
	// A name that never belonged to a session wakes an object with no grant,
	// which refuses to start at all; from out here that is the same wrong
	// address as a bad secret, and it gets the same answer.
	try {
		const session = await getAgentByName<Env, GmailMCP>(env.MCP_OBJECT, name);
		return await session.fetch(request);
	} catch {
		return new Response("no staging answers to this address", { status: 404 });
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path.startsWith("/upload/")) {
			return uploadRoute(request, env, path);
		}
		const limit = request.method === "POST" ? bodyLimitFor(path) : null;
		if (limit === null) {
			return provider.fetch(request, env, ctx);
		}
		// Registration needs no credentials and spends a KV write, which is the
		// scarce thing here: enough of them and the grants and tokens of everyone
		// already connected have nowhere to go.
		if (path === "/register" && env.REGISTER_LIMITER) {
			const caller = request.headers.get("cf-connecting-ip") ?? "unknown";
			const { success } = await env.REGISTER_LIMITER.limit({ key: caller });
			if (!success) {
				return new Response("Too many registration requests", { status: 429 });
			}
		}
		let body: Uint8Array;
		try {
			body = await readBoundedBody(request, limit);
		} catch (error: unknown) {
			if (error instanceof BodyTooLarge) {
				return new Response("Request body too large", { status: 413 });
			}
			throw error;
		}
		const bounded = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body,
		});
		return provider.fetch(bounded, env, ctx);
	},
};
