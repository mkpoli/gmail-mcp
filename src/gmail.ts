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

// RFC 2047 encoding for non-ASCII header values. An encoded-word may not
// exceed 75 octets, so longer values become several words joined by folding
// whitespace, split only on UTF-8 character boundaries.
function encodeHeader(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const bytes = new TextEncoder().encode(value);
	// "=?UTF-8?B?" + base64 + "?=" stays within 75 octets when the raw chunk is
	// at most 45 bytes, and a multiple of 3 keeps each word padding-free.
	const MAX_CHUNK = 45;
	const words: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		let take = Math.min(MAX_CHUNK, bytes.length - i);
		// Never cut a multi-byte character: continuation bytes start with 10xxxxxx.
		while (take > 1 && i + take < bytes.length && (bytes[i + take] & 0xc0) === 0x80) {
			take--;
		}
		words.push(`=?UTF-8?B?${bytesToB64(bytes.subarray(i, i + take))}?=`);
		i += take;
	}
	return words.join("\r\n ");
}

// Splits an address list on the commas that separate addresses, ignoring the
// ones inside a quoted display name, an angle-addr, or a parenthesised
// comment, and honouring backslash escapes inside quoted strings.
function splitAddressList(value: string): string[] {
	const out: string[] = [];
	let current = "";
	let quoted = false;
	let angled = false;
	let comment = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quoted && ch === "\\") {
			current += ch + (value[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === "(") comment++;
		else if (!quoted && ch === ")" && comment > 0) comment--;
		else if (ch === "<" && !quoted) angled = true;
		else if (ch === ">" && !quoted) angled = false;
		if (ch === "," && !quoted && !angled && comment === 0) {
			if (current.trim()) out.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

// Display names carry arbitrary text, so a non-ASCII one needs RFC 2047 just
// as a subject does; the address itself must stay untouched.
export function encodeAddressList(value: string): string {
	return splitAddressList(value)
		.map((address) => {
			const match = address.match(/^(.*?)\s*<([^>]*)>$/);
			if (!match) return address;
			const [, rawName, addr] = match;
			const trimmed = rawName.trim();
			// Unwrap a quoted display name back to its literal text, quoted-pairs
			// included, so re-quoting below does not escape the escapes.
			const quotedName = /^".*"$/s.test(trimmed);
			const name = quotedName ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1") : trimmed;
			if (!name) return `<${addr}>`;
			if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeader(name)} <${addr}>`;
			// RFC 5322 specials force a quoted-string display name.
			return /[",;:<>@[\]\\]/.test(name)
				? `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`
				: `${name} <${addr}>`;
		})
		.join(", ");
}

// RFC 5322 §2.1.1 caps a line at 998 octets and recommends 78, so a long
// recipient list or subject has to fold. Folding inserts CRLF before existing
// whitespace; a receiver unfolds by dropping the CRLF, which is why the break
// only ever lands on a space outside a quoted string. Values that already
// contain CRLF arrived folded — encoded-words do their own — and are left be.
function foldHeader(line: string): string {
	const LIMIT = 78;
	if (line.length <= LIMIT || line.includes("\r\n")) return line;

	const tokens: string[] = [];
	let buffer = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== "\\") quoted = !quoted;
		if (ch === " " && !quoted) {
			tokens.push(buffer);
			buffer = "";
			continue;
		}
		buffer += ch;
	}
	tokens.push(buffer);

	const lines: string[] = [];
	let current = "";
	for (const token of tokens) {
		if (!current) {
			current = token;
		} else if (current.length + 1 + token.length <= LIMIT) {
			current += ` ${token}`;
		} else {
			lines.push(current);
			current = token;
		}
	}
	lines.push(current);
	return lines.join("\r\n ");
}

// A media type reaches the header as a bare `type/subtype`; anything past a
// semicolon would add parameters of the caller's choosing, such as a second
// name= that parsers resolve differently from the real filename.
function assertMediaType(value: string): string {
	if (!/^[\w.+-]+\/[\w.+-]+$/.test(value)) {
		throw new Error(`invalid content type: ${value}`);
	}
	return value;
}

// RFC 2045 requires encoded body lines within 76 characters.
function wrap76(s: string): string {
	return s.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

function textPart(mimeType: string, content: string): string[] {
	return [
		`Content-Type: ${mimeType}; charset="UTF-8"`,
		"Content-Transfer-Encoding: base64",
		"",
		wrap76(bytesToB64(new TextEncoder().encode(content))),
	];
}

export type FilePart = {
	filename: string;
	contentType: string;
	// Standard base64 (whitespace tolerated).
	content: string;
};

export type InlineImage = {
	// Referenced from HTML as <img src="cid:...">.
	cid: string;
	contentType: string;
	content: string;
};

function normalizeB64(name: string, content: string): string {
	const cleaned = content.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
		throw new Error(`${name}: content must be standard base64`);
	}
	return wrap76(cleaned);
}

// A non-ASCII filename belongs in an RFC 2231 extended parameter. The legacy
// `name=` parameter keeps an RFC 2047 word beside it, which is what mail
// clients predating RFC 2231 read.
function filenameParams(filename: string): { name: string; disposition: string } {
	const quoted = filename.replace(/["\\]/g, "_");
	if (/^[\x20-\x7e]*$/.test(filename)) {
		return { name: `name="${quoted}"`, disposition: `filename="${quoted}"` };
	}
	const encoded = [...new TextEncoder().encode(filename)]
		.map((b) =>
			// attribute-char per RFC 2231: token characters minus * ' %
			(b >= 0x30 && b <= 0x39) ||
			(b >= 0x41 && b <= 0x5a) ||
			(b >= 0x61 && b <= 0x7a) ||
			[0x21, 0x23, 0x24, 0x26, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f, 0x60, 0x7c, 0x7e].includes(b)
				? String.fromCharCode(b)
				: `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
		)
		.join("");
	return {
		name: `name="${encodeHeader(filename).replace(/"/g, "'")}"`,
		disposition: `filename*=UTF-8''${encoded}`,
	};
}

function filePart(p: FilePart): string[] {
	assertHeaderSafe("attachment filename", p.filename);
	const contentType = assertMediaType(p.contentType);
	const params = filenameParams(p.filename);
	return [
		`Content-Type: ${contentType}; ${params.name}`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; ${params.disposition}`,
		"",
		normalizeB64(`attachment ${p.filename}`, p.content),
	];
}

function inlinePart(img: InlineImage): string[] {
	assertHeaderSafe("inline image cid", img.cid);
	const contentType = assertMediaType(img.contentType);
	if (!/^[\w.@-]+$/.test(img.cid)) {
		throw new Error(`invalid inline image cid: ${img.cid}`);
	}
	return [
		`Content-Type: ${contentType}`,
		"Content-Transfer-Encoding: base64",
		`Content-ID: <${img.cid}>`,
		"Content-Disposition: inline",
		"",
		normalizeB64(`inline image ${img.cid}`, img.content),
	];
}

// Wraps parts (each a line array with its own headers) into one multipart body.
function multipart(type: string, parts: string[][]): string[] {
	const boundary = `=_gmail-mcp_${crypto.randomUUID()}`;
	const lines = [`Content-Type: multipart/${type}; boundary="${boundary}"`, ""];
	for (const part of parts) {
		lines.push(`--${boundary}`, ...part, "");
	}
	lines.push(`--${boundary}--`);
	return lines;
}

export function buildRfc822({
	to,
	cc,
	bcc,
	from,
	subject,
	body,
	htmlBody,
	attachments = [],
	inlineImages = [],
	inReplyTo,
	references,
}: {
	to: string;
	cc?: string;
	bcc?: string;
	// Send-as alias; must already be configured in the account, Gmail rejects
	// or rewrites anything else.
	from?: string;
	subject: string;
	body: string;
	htmlBody?: string;
	attachments?: FilePart[];
	inlineImages?: InlineImage[];
	inReplyTo?: string;
	references?: string;
}): string {
	assertHeaderSafe("To", to);
	if (cc) assertHeaderSafe("Cc", cc);
	if (bcc) assertHeaderSafe("Bcc", bcc);
	if (from) assertHeaderSafe("From", from);
	assertHeaderSafe("Subject", subject);
	if (inReplyTo) assertHeaderSafe("In-Reply-To", inReplyTo);
	if (references) assertHeaderSafe("References", references);
	if (inlineImages.length > 0 && !htmlBody) {
		throw new Error("inline images require an htmlBody that references their cid");
	}

	const headers = [
		`To: ${encodeAddressList(to)}`,
		...(cc ? [`Cc: ${encodeAddressList(cc)}`] : []),
		...(bcc ? [`Bcc: ${encodeAddressList(bcc)}`] : []),
		...(from ? [`From: ${encodeAddressList(from)}`] : []),
		`Subject: ${encodeHeader(subject)}`,
		...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
		...(references ? [`References: ${references}`] : []),
		"MIME-Version: 1.0",
	].map(foldHeader);

	// Innermost: the readable body, as plain text or plain+HTML alternative.
	let core: string[] = htmlBody
		? multipart("alternative", [textPart("text/plain", body), textPart("text/html", htmlBody)])
		: textPart("text/plain", body);

	// Inline images join the body in a related container.
	if (inlineImages.length > 0) {
		core = multipart("related", [core, ...inlineImages.map(inlinePart)]);
	}

	// File attachments wrap everything in a mixed container.
	if (attachments.length > 0) {
		core = multipart("mixed", [core, ...attachments.map(filePart)]);
	}

	return [...headers, ...core].join("\r\n");
}

// ---- Reply helpers ----------------------------------------------------------

// Extracts bare addresses from a header value, tolerating display names with
// commas inside quotes ("Doe, John" <j@example.com>).
export function parseAddresses(header: string | undefined): string[] {
	if (!header) return [];
	const out: string[] = [];
	for (const entry of splitAddressList(header)) {
		const angled = entry.match(/<([^<>\s]+@[^<>\s]+)>/);
		if (angled) {
			out.push(angled[1].toLowerCase());
			continue;
		}
		// No angle-addr: drop comments and quoted text, then take the address token.
		const bare = entry
			.replace(/\([^)]*\)/g, " ")
			.replace(/"(?:[^"\\]|\\.)*"/g, " ")
			.match(/([^\s<>@",]+@[^\s<>@",]+)/);
		if (bare) out.push(bare[1].toLowerCase());
	}
	return [...new Set(out)];
}

export function replySubject(original: string | undefined): string {
	const s = original ?? "";
	return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(original: string | undefined): string {
	const s = original ?? "";
	return /^\s*(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
}

// The header block Gmail and Thunderbird both put above forwarded content.
export function forwardHeaderBlock(fields: {
	from?: string;
	date?: string;
	subject?: string;
	to?: string;
	cc?: string;
}): string {
	return [
		"---------- Forwarded message ---------",
		`From: ${fields.from ?? "unknown"}`,
		`Date: ${fields.date ?? "unknown"}`,
		`Subject: ${fields.subject ?? ""}`,
		`To: ${fields.to ?? ""}`,
		...(fields.cc ? [`Cc: ${fields.cc}`] : []),
	].join("\n");
}

export function forwardHtmlBlock(fields: {
	from?: string;
	date?: string;
	subject?: string;
	to?: string;
	cc?: string;
	body: string;
}): string {
	const rows = [
		["From", fields.from],
		["Date", fields.date],
		["Subject", fields.subject],
		["To", fields.to],
		["Cc", fields.cc],
	]
		.filter(([, v]) => v)
		.map(([k, v]) => `<div><b>${k}:</b> ${escapeHtml(String(v))}</div>`)
		.join("\n");
	return [
		"<div>---------- Forwarded message ---------</div>",
		rows,
		'<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">',
		escapeHtml(fields.body).replace(/\n/g, "<br>\n"),
		"</blockquote>",
	].join("\n");
}

export function quotePlain(from: string, date: string, body: string): string {
	const quoted = body
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return `On ${date}, ${from} wrote:\n${quoted}`;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function quoteHtml(from: string, date: string, plainBody: string): string {
	return [
		`<div>On ${escapeHtml(date)}, ${escapeHtml(from)} wrote:</div>`,
		`<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">`,
		escapeHtml(plainBody).replace(/\n/g, "<br>\n"),
		"</blockquote>",
	].join("\n");
}

// RFC 5322 §3.6.4 spells a msg-id "<id-left@id-right>", and In-Reply-To carries
// that header value. The Gmail API's own message id contains no "@" and threads
// nothing, so a caller passing one has to resolve it to the real Message-ID;
// null says which case this is.
export function normalizeMessageId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed.includes("@")) return null;
	return /^<[\s\S]*>$/.test(trimmed) ? trimmed : `<${trimmed}>`;
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
	// An emoji or other astral character occupies two code units, so a cut at
	// the limit can land between them and leave a lone surrogate. That survives
	// JSON but not UTF-8, and a truncated body is also what a reply quotes back
	// into outgoing mail, so the cut retreats to the start of the character.
	const high = text.charCodeAt(limit - 1);
	const low = text.charCodeAt(limit);
	const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
	const end = splitsPair ? limit - 1 : limit;
	return `${text.slice(0, end)}\n[truncated: ${text.length - end} of ${text.length} characters omitted]`;
}

export function summarizeMessage(m: any) {
	return {
		id: m.id,
		threadId: m.threadId,
		labelIds: m.labelIds,
		snippet: m.snippet,
		from: headerValue(m, "From"),
		to: headerValue(m, "To"),
		cc: headerValue(m, "Cc"),
		date: headerValue(m, "Date"),
		subject: headerValue(m, "Subject"),
	};
}
