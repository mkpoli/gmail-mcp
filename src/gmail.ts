// Minimal Gmail REST helpers. The googleapis package is too heavy for Workers;
// every call here is a plain fetch against gmail.googleapis.com.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export async function gmailFetch(
	accessToken: string,
	path: string,
	init: RequestInit = {},
): Promise<any> {
	const resp = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!resp.ok) {
		throw new GmailApiError(resp.status, await resp.text());
	}
	if (resp.status === 204) return null;
	return resp.json();
}

// Chunked binary-to-base64: a spread into String.fromCharCode overflows the
// argument limit on bodies past a few tens of kilobytes.
function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

export function b64urlEncode(s: string): string {
	return bytesToB64(new TextEncoder().encode(s))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

// Header values are attacker-influenceable through prompt injection (mail
// content steers the model, the model fills tool arguments), so CR/LF must
// never reach the raw RFC822 header block: it would smuggle extra headers,
// e.g. a silent Bcc.
function assertHeaderSafe(name: string, value: string): string {
	if (/[\r\n\0]/.test(value)) {
		throw new Error(`invalid ${name} header value: contains line break or NUL`);
	}
	return value;
}

// RFC 2047 encoding for non-ASCII header values (Subject, names).
function encodeHeader(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	return `=?UTF-8?B?${bytesToB64(new TextEncoder().encode(value))}?=`;
}

// RFC 2045 requires encoded body lines within 76 characters.
function wrap76(s: string): string {
	return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

export function buildRfc822({
	to,
	cc,
	bcc,
	subject,
	body,
	inReplyTo,
	references,
}: {
	to: string;
	cc?: string;
	bcc?: string;
	subject: string;
	body: string;
	inReplyTo?: string;
	references?: string;
}): string {
	assertHeaderSafe("To", to);
	if (cc) assertHeaderSafe("Cc", cc);
	if (bcc) assertHeaderSafe("Bcc", bcc);
	assertHeaderSafe("Subject", subject);
	if (inReplyTo) assertHeaderSafe("In-Reply-To", inReplyTo);
	if (references) assertHeaderSafe("References", references);

	const lines = [
		`To: ${to}`,
		...(cc ? [`Cc: ${cc}`] : []),
		...(bcc ? [`Bcc: ${bcc}`] : []),
		`Subject: ${encodeHeader(subject)}`,
		...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
		...(references ? [`References: ${references}`] : []),
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(bytesToB64(new TextEncoder().encode(body))),
	];
	return lines.join("\r\n");
}

export function headerValue(message: any, name: string): string | undefined {
	return message?.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())
		?.value;
}

function b64urlToBytes(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

function partCharset(part: any): string {
	const ct = part?.headers?.find((h: any) => h.name.toLowerCase() === "content-type")?.value;
	return ct?.match(/charset="?([\w-]+)"?/i)?.[1] ?? "utf-8";
}

// Decodes part data honoring its declared charset (ISO-2022-JP and friends);
// unknown charsets fall back to UTF-8.
function decodePartData(part: any): string {
	const bytes = b64urlToBytes(part.body.data);
	try {
		return new TextDecoder(partCharset(part)).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

function flattenParts(payload: any): any[] {
	const parts: any[] = [];
	const walk = (p: any) => {
		if (!p) return;
		parts.push(p);
		(p.parts ?? []).forEach(walk);
	};
	walk(payload);
	return parts;
}

function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s{3,}/g, "\n")
		.trim();
}

// Walks the MIME tree and returns the first text/plain part, falling back to
// text/html with tags stripped.
export function extractBody(payload: any): string {
	const parts = flattenParts(payload);

	const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
	if (plain) return decodePartData(plain);

	const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
	if (html) return htmlToText(decodePartData(html));

	return "";
}

// Gmail stores large text parts as attachments (body.attachmentId, no data);
// callers fetch those bytes separately and decode here.
export function textPartAttachment(
	payload: any,
): { attachmentId: string; mimeType: string; charset: string } | null {
	const parts = flattenParts(payload);
	const part =
		parts.find((p) => p.mimeType === "text/plain" && p.body?.attachmentId && !p.filename) ??
		parts.find((p) => p.mimeType === "text/html" && p.body?.attachmentId && !p.filename);
	if (!part) return null;
	return {
		attachmentId: part.body.attachmentId,
		mimeType: part.mimeType,
		charset: partCharset(part),
	};
}

export function decodeAttachmentText(data: string, mimeType: string, charset: string): string {
	const bytes = b64urlToBytes(data);
	let text: string;
	try {
		text = new TextDecoder(charset).decode(bytes);
	} catch {
		text = new TextDecoder().decode(bytes);
	}
	return mimeType === "text/html" ? htmlToText(text) : text;
}

export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[truncated: ${text.length - limit} of ${text.length} characters omitted]`;
}

export function summarizeMessage(m: any) {
	return {
		id: m.id,
		threadId: m.threadId,
		labelIds: m.labelIds,
		snippet: m.snippet,
		from: headerValue(m, "From"),
		to: headerValue(m, "To"),
		date: headerValue(m, "Date"),
		subject: headerValue(m, "Subject"),
	};
}
