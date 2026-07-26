import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	b64urlEncode,
	buildRfc822,
	decodeAttachmentText,
	extractBody,
	GmailApiError,
	gmailFetch,
	headerValue,
	parseAddresses,
	quoteHtml,
	quotePlain,
	replySubject,
	summarizeMessage,
	textPartAttachment,
	truncate,
} from "./gmail";
import { GoogleHandler } from "./google-handler";
import { type Props, refreshGoogleToken } from "./utils";

type TokenCache = { accessToken: string; expiresAt: number };

// Character budgets keep decoded mail bodies from flooding Durable Object
// memory or the MCP client's context window.
const BODY_LIMIT = 50_000;
const THREAD_BODY_LIMIT = 10_000;
// Whole-thread ceiling: a long notification thread would otherwise return
// hundreds of kilobytes of quoted machine-generated mail.
const THREAD_TOTAL_BUDGET = 30_000;
// Base64 payload budget for attachment downloads (~1.5 MB of file data).
const ATTACHMENT_B64_LIMIT = 2_000_000;

const filePartSchema = z.object({
	filename: z.string(),
	contentType: z.string(),
	content: z.string().describe("File data as standard base64"),
});

const inlineImageSchema = z.object({
	cid: z.string().describe('Content-ID referenced from the HTML as <img src="cid:...">'),
	contentType: z.string(),
	content: z.string().describe("Image data as standard base64"),
});

export class GmailMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Gmail MCP",
		version: "0.1.0",
	});

	// Access tokens live one hour; the refresh token from props mints new ones.
	// The freshest token is kept in DO storage because props are immutable
	// for the lifetime of the MCP grant.
	private get grantProps(): Props {
		if (!this.props) throw new Error("missing auth props on MCP session");
		return this.props;
	}

	// Single-flight guard: concurrent tool calls near expiry share one refresh.
	private refreshing: Promise<string> | null = null;

	private async token(forceRefresh = false): Promise<string> {
		if (!forceRefresh) {
			const cached = await this.ctx.storage.get<TokenCache>("token");
			const current = cached ?? {
				accessToken: this.grantProps.accessToken,
				expiresAt: this.grantProps.expiresAt,
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
					refresh_token: this.grantProps.refreshToken,
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

	private async api(path: string, init: RequestInit = {}): Promise<any> {
		try {
			return await gmailFetch(await this.token(), path, init);
		} catch (e) {
			if (e instanceof GmailApiError && e.status === 401) {
				// Token revoked or expired early. The props token may be the one
				// that just failed, so refresh unconditionally before retrying.
				return gmailFetch(await this.token(true), path, init);
			}
			// Gmail's per-user rate limit is bursty; one backoff clears most of it.
			if (e instanceof GmailApiError && (e.status === 429 || e.status === 503)) {
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
	): Promise<R[]> {
		const out: R[] = new Array(items.length);
		let next = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		});
		await Promise.all(workers);
		return out;
	}

	// Inline part data first; when Gmail externalizes a large text part as an
	// attachment, fetch and decode those bytes.
	private async messageBody(m: any): Promise<string> {
		const inline = extractBody(m.payload);
		if (inline) return inline;
		const ref = textPartAttachment(m.payload);
		if (!ref) return "";
		const att = await this.api(
			`/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(ref.attachmentId)}`,
		);
		if (!att?.data) return "";
		return decodeAttachmentText(att.data, ref.mimeType, ref.charset);
	}

	private text(data: unknown) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		};
	}

	async init() {
		const account = this.grantProps.email;

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
				const list = await this.api(`/messages?${params}`);
				const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
				const messages = await this.mapLimited(ids, 8, (id) =>
					this.api(
						`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
					),
				);
				return this.text({
					resultSizeEstimate: list.resultSizeEstimate,
					nextPageToken: list.nextPageToken,
					messages: messages.map(summarizeMessage),
				});
			},
		);

		this.server.tool(
			"get_message",
			`Read a full message from ${account}, including decoded body text`,
			{ messageId: z.string() },
			async ({ messageId }) => {
				const m = await this.api(`/messages/${encodeURIComponent(messageId)}?format=full`);
				return this.text({
					...summarizeMessage(m),
					messageIdHeader: headerValue(m, "Message-ID"),
					body: truncate(await this.messageBody(m), BODY_LIMIT),
					attachments: collectAttachments(m.payload),
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
				const t = await this.api(
					`/threads/${encodeURIComponent(threadId)}?format=${includeBodies ? "full" : "metadata"}`,
				);
				const all: any[] = t.messages ?? [];
				const kept = all.slice(-maxMessages);
				const omitted = all.length - kept.length;

				if (!includeBodies) {
					return this.text({
						messageCount: all.length,
						omitted,
						messages: kept.map(summarizeMessage),
					});
				}

				// One budget for the whole thread; each message gets an equal share
				// so a single long message cannot crowd out the rest.
				const perMessage = Math.max(
					1000,
					Math.floor(THREAD_TOTAL_BUDGET / Math.max(kept.length, 1)),
				);
				const messages = await this.mapLimited(kept, 4, async (m: any) => ({
					...summarizeMessage(m),
					body: truncate(await this.messageBody(m), Math.min(perMessage, THREAD_BODY_LIMIT)),
				}));
				return this.text({ messageCount: all.length, omitted, messages });
			},
		);

		this.server.tool("list_labels", `List labels in ${account}`, {}, async () => {
			const l = await this.api("/labels");
			return this.text(
				(l.labels ?? []).map((x: any) => ({ id: x.id, name: x.name, type: x.type })),
			);
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
			`Create a draft in ${account} without sending`,
			draftFields,
			async ({ to, subject, body, htmlBody, cc, bcc, from, attachments, inlineImages }) => {
				const raw = b64urlEncode(
					buildRfc822({ to, cc, bcc, from, subject, body, htmlBody, attachments, inlineImages }),
				);
				const d = await this.api("/drafts", {
					method: "POST",
					body: JSON.stringify({ message: { raw } }),
				});
				return this.text({ draftId: d.id, messageId: d.message?.id });
			},
		);

		this.server.tool(
			"update_draft",
			`Replace the content of a draft in ${account}`,
			{ draftId: z.string(), ...draftFields },
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
				const raw = b64urlEncode(
					buildRfc822({ to, cc, bcc, from, subject, body, htmlBody, attachments, inlineImages }),
				);
				const d = await this.api(`/drafts/${encodeURIComponent(draftId)}`, {
					method: "PUT",
					body: JSON.stringify({ message: { raw } }),
				});
				return this.text({ draftId: d.id, messageId: d.message?.id });
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
			{ maxResults: z.number().int().min(1).max(50).default(10) },
			async ({ maxResults }) => {
				const l = await this.api(`/drafts?maxResults=${maxResults}`);
				const drafts: any[] = l.drafts ?? [];
				// The list response carries ids only, which say nothing about which
				// draft is which; pull the headers that identify them.
				const detailed = await this.mapLimited(drafts, 8, async (d: any) => {
					const full = await this.api(
						`/drafts/${encodeURIComponent(d.id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
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
				return this.text(detailed);
			},
		);

		this.server.tool(
			"send_message",
			`Send mail as ${account}. For replies pass threadId plus the original's Message-ID header as inReplyTo`,
			{
				to: z.string(),
				subject: z.string(),
				body: z.string().describe("Plain-text body"),
				htmlBody: z.string().optional().describe("HTML alternative shown by rich clients"),
				cc: z.string().optional(),
				bcc: z.string().optional(),
				threadId: z.string().optional(),
				inReplyTo: z
					.string()
					.optional()
					.describe("Message-ID header value of the message being replied to"),
			},
			async ({ to, subject, body, htmlBody, cc, bcc, threadId, inReplyTo }) => {
				const raw = b64urlEncode(
					buildRfc822({
						to,
						cc,
						bcc,
						subject,
						body,
						htmlBody,
						inReplyTo,
						references: inReplyTo,
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
				const original = await this.api(`/messages/${encodeURIComponent(messageId)}?format=full`);
				const self = account.toLowerCase();
				const fromAddrs = parseAddresses(headerValue(original, "From"));
				const toAddrs = parseAddresses(headerValue(original, "To"));
				const ccAddrs = parseAddresses(headerValue(original, "Cc"));
				const replyToHeader = parseAddresses(headerValue(original, "Reply-To"));

				const primary = (replyToHeader.length > 0 ? replyToHeader : fromAddrs).filter(
					(a) => a !== self,
				);
				const rest = [...toAddrs, ...ccAddrs].filter((a) => a !== self && !primary.includes(a));
				// Replying to own sent mail: keep the original recipients.
				const to = primary.length > 0 ? primary : toAddrs.filter((a) => a !== self);
				if (to.length === 0) {
					throw new Error("reply_all found no recipient other than this account");
				}

				const messageIdHeader = headerValue(original, "Message-ID");
				const references = [headerValue(original, "References"), messageIdHeader]
					.filter(Boolean)
					.join(" ");
				const fromDisplay = headerValue(original, "From") ?? "unknown sender";
				const date = headerValue(original, "Date") ?? "an earlier date";
				const originalBody = await this.messageBody(original);
				const quoted = truncate(originalBody, THREAD_BODY_LIMIT);

				const raw = b64urlEncode(
					buildRfc822({
						to: to.join(", "),
						cc: rest.length > 0 ? rest.join(", ") : undefined,
						subject: replySubject(headerValue(original, "Subject")),
						body: `${body}\n\n${quotePlain(fromDisplay, date, quoted)}`,
						htmlBody: htmlBody
							? `${htmlBody}\n<br>\n${quoteHtml(fromDisplay, date, quoted)}`
							: undefined,
						attachments,
						inlineImages,
						inReplyTo: messageIdHeader,
						references: references || undefined,
					}),
				);
				const m = await this.api("/messages/send", {
					method: "POST",
					body: JSON.stringify({ raw, threadId: original.threadId }),
				});
				return this.text({ id: m.id, threadId: m.threadId, to, cc: rest });
			},
		);

		this.server.tool(
			"get_attachment",
			`Download an attachment from a message in ${account} (base64, capped at ~1.5 MB; text types also decoded)`,
			{
				messageId: z.string(),
				attachmentId: z.string(),
				textOnly: z
					.boolean()
					.default(false)
					.describe("Return only decoded text for text/* attachments, no base64"),
			},
			async ({ messageId, attachmentId, textOnly }) => {
				const att = await this.api(
					`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
				);
				const data: string = att?.data ?? "";
				if (data.length > ATTACHMENT_B64_LIMIT) {
					return this.text({
						size: att.size,
						error: `attachment exceeds the ${ATTACHMENT_B64_LIMIT} base64-character budget; fetch it with a regular mail client`,
					});
				}
				if (textOnly) {
					return this.text({
						size: att.size,
						text: truncate(decodeAttachmentText(data, "text/plain", "utf-8"), BODY_LIMIT),
					});
				}
				return this.text({ size: att.size, dataBase64Url: data });
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
				const t = await this.api(`/threads/${encodeURIComponent(threadId)}/modify`, {
					method: "POST",
					body: JSON.stringify({ addLabelIds, removeLabelIds }),
				});
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
			{ name: z.string().describe("Nested labels use '/', e.g. Projects/Ainu") },
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

function collectAttachments(payload: any) {
	const out: { filename: string; mimeType: string; size: number }[] = [];
	const walk = (p: any) => {
		if (!p) return;
		if (p.filename && p.body?.attachmentId) {
			out.push({ filename: p.filename, mimeType: p.mimeType, size: p.body.size });
		}
		(p.parts ?? []).forEach(walk);
	};
	walk(payload);
	return out;
}

const mcpHandler = GmailMCP.serve("/mcp");

// Any /mcp/<label> URL serves the same MCP: clients that dedupe servers by
// URL can hold one connection per Google account under freely chosen labels
// (each URL signs in independently; sessions ride the Mcp-Session-Id header,
// so the path rewrite does not mix connections).
const aliasHandler = {
	fetch: (request: Request, env: unknown, ctx: unknown) => {
		const url = new URL(request.url);
		url.pathname = "/mcp";
		return (mcpHandler as any).fetch(new Request(url, request), env, ctx);
	},
};

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": mcpHandler as any,
		"/mcp/": aliasHandler as any,
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
});
