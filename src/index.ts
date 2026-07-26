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
			throw e;
		}
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
				const messages = await Promise.all(
					ids.map((id) =>
						this.api(
							`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
						),
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
			`Read a whole conversation thread from ${account}`,
			{ threadId: z.string() },
			async ({ threadId }) => {
				const t = await this.api(`/threads/${encodeURIComponent(threadId)}?format=full`);
				return this.text(
					await Promise.all(
						(t.messages ?? []).map(async (m: any) => ({
							...summarizeMessage(m),
							body: truncate(await this.messageBody(m), THREAD_BODY_LIMIT),
						})),
					),
				);
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
			async ({ messageId, addLabelIds, removeLabelIds }) =>
				this.text(
					summarizeMessage(
						await this.api(`/messages/${encodeURIComponent(messageId)}/modify`, {
							method: "POST",
							body: JSON.stringify({ addLabelIds, removeLabelIds }),
						}),
					),
				),
		);

		this.server.tool(
			"trash_message",
			`Move a message to the trash in ${account} (reversible for 30 days)`,
			{ messageId: z.string() },
			async ({ messageId }) =>
				this.text(
					summarizeMessage(
						await this.api(`/messages/${encodeURIComponent(messageId)}/trash`, {
							method: "POST",
						}),
					),
				),
		);

		this.server.tool(
			"create_draft",
			`Create a draft in ${account} without sending`,
			{
				to: z.string(),
				subject: z.string(),
				body: z.string().describe("Plain-text body"),
				htmlBody: z.string().optional().describe("HTML alternative shown by rich clients"),
				cc: z.string().optional(),
				bcc: z.string().optional(),
			},
			async ({ to, subject, body, htmlBody, cc, bcc }) => {
				const raw = b64urlEncode(buildRfc822({ to, cc, bcc, subject, body, htmlBody }));
				const d = await this.api("/drafts", {
					method: "POST",
					body: JSON.stringify({ message: { raw } }),
				});
				return this.text({ draftId: d.id, messageId: d.message?.id });
			},
		);

		this.server.tool(
			"list_drafts",
			`List drafts in ${account}`,
			{ maxResults: z.number().int().min(1).max(50).default(10) },
			async ({ maxResults }) => {
				const l = await this.api(`/drafts?maxResults=${maxResults}`);
				return this.text(l.drafts ?? []);
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
