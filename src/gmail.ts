// Minimal Gmail REST helpers. The googleapis package is too heavy for Workers;
// every call here is a plain fetch against gmail.googleapis.com.

import { readBoundedText } from "./utils";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Assembling a message copies it several times over — normalised, wrapped,
// joined, encoded — so what may arrive is bounded well below both Gmail's own
// 25 MB limit and the isolate's memory, rather than just under them.
export const MAX_ENCODED_ATTACHMENT_BYTES = 8_000_000;

// What a run of bytes costs once base64 has been applied to it. Callers that
// bound a fetch need the same figure the builder will compare against.
export function encodedSize(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}
// The written parts of a message are bounded too; nothing else caps them.
const MAX_BODY_CHARS = 1_000_000;

// RFC 5322 §2.1.1 caps a line at 998 octets. Folding breaks at spaces, so a
// stretch without one has to fit a line on its own, allowing for the field name.
const MAX_HEADER_RUN = 900;

// A ceiling on any single Gmail response. Reading one costs several copies at
// once — the chunks, the joined bytes, the decoded string, the parsed object —
// so the ceiling sits well below the isolate's own limit rather than near it.
const MAX_RESPONSE_BYTES = 6_000_000;
// How long a single Gmail call may take before it is abandoned.
const GMAIL_TIMEOUT_MS = 30_000;
// As much of a failure as is worth repeating back to the caller.

// The parts of Gmail's message shape this server reads. Everything is optional
// because the API omits fields by format and by message: a metadata read has no
// body, an externalized part has no data, a malformed sender may send no name.
export type GmailHeader = { name?: string | undefined; value?: string | undefined };
export type GmailBody = {
	size?: number | undefined;
	data?: string | undefined;
	attachmentId?: string | undefined;
};
export type GmailPart = {
	mimeType?: string | undefined;
	filename?: string | undefined;
	headers?: GmailHeader[] | undefined;
	body?: GmailBody | undefined;
	parts?: GmailPart[] | undefined;
};
export type GmailMessage = {
	id?: string | undefined;
	threadId?: string | undefined;
	labelIds?: string[] | undefined;
	snippet?: string | undefined;
	payload?: GmailPart | undefined;
};

export class GmailApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export async function gmailFetch<T = unknown>(
	accessToken: string,
	path: string,
	init: RequestInit = {},
	limit: number = MAX_RESPONSE_BYTES,
): Promise<T> {
	// Nothing else bounds how long a call may hang, and a stalled one holds the
	// session's object open behind it.
	const resp = await fetch(`${BASE}${path}`, {
		...init,
		signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!resp.ok) {
		// An error body is a response like any other, and nothing else caps it.
		// Trimming after the fact still holds whatever arrived, so it is counted
		// on the way in and the rest is left unread.
		const detail = await readBoundedText(resp.body);
		throw new GmailApiError(resp.status, detail);
	}
	if (resp.status === 204) return null as T;

	// A whole-thread read returns every message's body, and parsing arrives
	// before any of the character budgets can apply. Counting the bytes as they
	// come turns a response that would exhaust the isolate into an error naming
	// what to do instead.
	const reader = resp.body?.getReader();
	if (!reader) return null as T;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new GmailApiError(
				413,
				`Gmail returned more than ${limit} bytes for ${path}. Read the messages individually, or ask for a thread without bodies.`,
			);
		}
		chunks.push(value);
	}
	// A success with nothing in it is a success, not malformed JSON.
	if (total === 0) return null as T;
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body)) as T;
}

// Chunked binary-to-base64: a spread into String.fromCharCode overflows the
// argument limit on bodies past a few tens of kilobytes.
export function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

// Gmail returns attachment bytes as base64url with the padding stripped, and
// the message builder accepts only standard base64, whose length is a multiple
// of four. A length that leaves one byte over is malformed either way and is
// left to fail in the builder.
export function b64urlToStandard(data: string): string {
	const standard = data.replace(/-/g, "+").replace(/_/g, "/");
	const remainder = standard.length % 4;
	return remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
}

export function b64urlEncode(s: string): string {
	return bytesToB64(new TextEncoder().encode(s))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
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

// Text can travel as encoded-words, which break anywhere; a message id has to
// stay literal, so a stretch of one without a space has to fit a line by
// itself or it cannot be sent at all.
// Where a header line may be broken: at a space outside a quoted string. One
// stray quote would open a string that never closes, so the quotes are honoured
// only when they balance.
function headerRuns(value: string): string[] {
	const split = (respectQuotes: boolean): string[] => {
		const out: string[] = [];
		let buffer = "";
		let quoted = false;
		for (let i = 0; i < value.length; i++) {
			const ch = value[i];
			if (respectQuotes && ch === '"' && value[i - 1] !== "\\") quoted = !quoted;
			if (ch === " " && !quoted) {
				out.push(buffer);
				buffer = "";
				continue;
			}
			buffer += ch;
		}
		out.push(buffer);
		return quoted ? split(false) : out;
	};
	return split(true);
}

// Measured the way the folder breaks, or the two disagree: a quoted display
// name full of spaces looks foldable run by run while the folder keeps it
// whole, and the line it writes has nowhere to break.
function fitsHeaderLine(value: string): boolean {
	return headerRuns(value).every((run) => run.length <= MAX_HEADER_RUN);
}

function assertLiteralFits(name: string, value: string): string {
	if (!fitsHeaderLine(value)) {
		throw new Error(`${name} header value is too long to fit a header line`);
	}
	return value;
}

// RFC 2047 encoding for non-ASCII header values. An encoded-word may not
// exceed 75 octets, so longer values become several words joined by folding
// whitespace, split only on UTF-8 character boundaries.
function encodeHeader(value: string): string {
	// Folding can only break at whitespace, so a run without any is stuck on one
	// line and an ASCII value can still pass the 998-octet limit. Encoded-words
	// break anywhere, and RFC 2047 §6.2 has a receiver drop the whitespace
	// between adjacent ones, so nothing is added to the text on the way out.
	const foldable = value.split(" ").every((run) => run.length <= 78);
	if (/^[\x20-\x7e]*$/.test(value) && foldable) return value;
	const bytes = new TextEncoder().encode(value);
	// "=?UTF-8?B?" + base64 + "?=" stays within 75 octets when the raw chunk is
	// at most 45 bytes, and a multiple of 3 keeps each word padding-free.
	const MAX_CHUNK = 45;
	const words: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		let take = Math.min(MAX_CHUNK, bytes.length - i);
		// Never cut a multi-byte character: continuation bytes start with 10xxxxxx.
		while (take > 1 && i + take < bytes.length && ((bytes[i + take] ?? 0) & 0xc0) === 0x80) {
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
function encodeAddressList(value: string): string {
	return splitAddressList(value)
		.map((address) => {
			const match = address.match(/^(.*?)\s*<([^>]*)>$/);
			if (!match) return address;
			const rawName = match[1] ?? "";
			const addr = match[2] ?? "";
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
// only ever lands on a space outside a quoted string.
function foldHeader(line: string): string {
	// Encoded-words fold themselves, and what follows the fold they inserted
	// still has to be folded: a header carrying one used to be passed through
	// whole, so a long recipient list behind a non-ASCII display name grew past
	// the limit with nothing to break it.
	if (line.includes("\r\n")) {
		// Only the hard limit applies here. Breaking these at the recommended
		// width would split an encoded word from its own header name and rewrite
		// output that is already correct.
		return line
			.split("\r\n")
			.map((segment) =>
				segment.startsWith(" ")
					? ` ${foldSegment(segment.slice(1), MAX_HEADER_RUN)}`
					: foldSegment(segment, MAX_HEADER_RUN),
			)
			.join("\r\n");
	}
	return foldSegment(line, 78);
}

function foldSegment(line: string, LIMIT: number): string {
	if (line.length <= LIMIT) return line;

	const tokens = headerRuns(line);

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

// A part's own headers are assembled separately from the message headers, so
// they never reach foldHeader; an over-long filename would sit on one line past
// the limit. Refusing is right here because the name has to travel literally.
function assertPartHeaderFits(name: string, value: string): string {
	if (value.length > MAX_HEADER_RUN) {
		throw new Error(`${name} is too long to fit a header line`);
	}
	return value;
}

function filePart(p: FilePart): string[] {
	assertHeaderSafe("attachment filename", p.filename);
	const contentType = assertMediaType(p.contentType);
	const params = filenameParams(p.filename);
	// The two parameters land on separate lines, so each is measured on its
	// own. A name outside ASCII is percent-encoded into three characters a
	// byte, and measuring the pair together refused ordinary Japanese and
	// Chinese filenames whose headers would have been well inside the limit.
	const type = assertPartHeaderFits(
		"attachment filename",
		`Content-Type: ${contentType}; ${params.name}`,
	);
	const disposition = assertPartHeaderFits(
		"attachment filename",
		`Content-Disposition: attachment; ${params.disposition}`,
	);
	return [
		type,
		"Content-Transfer-Encoding: base64",
		disposition,
		"",
		normalizeB64(`attachment ${p.filename}`, p.content),
	];
}

function inlinePart(img: InlineImage): string[] {
	assertHeaderSafe("inline image cid", img.cid);
	const contentType = assertMediaType(img.contentType);
	// Nothing but an image can be reached through <img src="cid:...">, so any
	// other type here is a body part riding along outside the alternative set.
	if (!contentType.toLowerCase().startsWith("image/")) {
		throw new Error(`inline images must be an image type, not ${contentType}`);
	}
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
	cc?: string | undefined;
	bcc?: string | undefined;
	// Send-as alias; must already be configured in the account, Gmail rejects
	// or rewrites anything else.
	from?: string | undefined;
	subject: string;
	body: string;
	htmlBody?: string | undefined;
	attachments?: FilePart[] | undefined;
	inlineImages?: InlineImage[] | undefined;
	inReplyTo?: string | undefined;
	references?: string | undefined;
}): string {
	assertHeaderSafe("To", to);
	if (cc) assertHeaderSafe("Cc", cc);
	if (bcc) assertHeaderSafe("Bcc", bcc);
	if (from) assertHeaderSafe("From", from);
	assertHeaderSafe("Subject", subject);
	if (inReplyTo) assertLiteralFits("In-Reply-To", assertHeaderSafe("In-Reply-To", inReplyTo));
	if (references) assertLiteralFits("References", assertHeaderSafe("References", references));
	for (const [name, value] of [
		["To", to],
		["Cc", cc ?? ""],
		["Bcc", bcc ?? ""],
		["From", from ?? ""],
	] as const) {
		// What has to fit is the list as it will be written, which is rejoined
		// with ", " and so folds at every address. Measuring what the caller
		// typed refuses a list separated by bare commas for having no space in
		// it, while the header built from it would have had one throughout.
		if (value) assertLiteralFits(name, encodeAddressList(value));
	}
	if (!to.trim() && !cc?.trim() && !bcc?.trim()) {
		// A message may name no To at all as long as it reaches someone: a
		// Bcc-only announcement is ordinary mail, not a mistake.
		throw new Error("a message needs at least one recipient in To, Cc or Bcc");
	}
	if (inlineImages.length > 0 && !htmlBody) {
		throw new Error("inline images require an htmlBody that references their cid");
	}
	// Assembly copies the payload several times over — normalized, wrapped,
	// joined, encoded — so a message far past what Gmail would accept anyway
	// is refused before any of those copies exist.
	if (body.length > MAX_BODY_CHARS || (htmlBody?.length ?? 0) > MAX_BODY_CHARS) {
		throw new Error(`a message body may not exceed ${MAX_BODY_CHARS} characters`);
	}
	const encodedBytes = [...attachments, ...inlineImages].reduce(
		(total, part) => total + part.content.length,
		0,
	);
	if (encodedBytes > MAX_ENCODED_ATTACHMENT_BYTES) {
		throw new Error(
			`attachments total ${encodedBytes} encoded bytes, past the ${MAX_ENCODED_ATTACHMENT_BYTES}-byte ceiling`,
		);
	}

	const headers = [
		// A message may name no To at all when it reaches someone by Cc or Bcc.
		// RFC 5322 §3.6.3 has no empty address-list, so the field is left out
		// rather than written empty, the way the three below already are.
		...(to.trim() ? [`To: ${encodeAddressList(to)}`] : []),
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
			out.push((angled[1] ?? "").toLowerCase());
			continue;
		}
		// No angle-addr: drop comments and quoted text, then take the address token.
		const bare = entry
			.replace(/\([^)]*\)/g, " ")
			.replace(/"(?:[^"\\]|\\.)*"/g, " ")
			// A group ends with a semicolon that belongs to the group, not to the
			// last address in it.
			.match(/([^\s<>@",;]+@[^\s<>@",;]+)/);
		if (bare?.[1]) out.push(bare[1].toLowerCase());
	}
	return [...new Set(out)];
}

// Gmail delivers to one mailbox whatever tag or dots an address carries, so a
// reply has to recognise those forms as the account itself instead of copying
// them back to their owner. Dots fold away on gmail.com and its googlemail.com
// alias; on a Workspace domain they are part of the address and stay.
export function canonicalAddress(address: string): string {
	const at = address.lastIndexOf("@");
	if (at < 0) return address.trim().toLowerCase();
	let local = address.slice(0, at).trim().toLowerCase();
	let domain = address
		.slice(at + 1)
		.trim()
		.toLowerCase();
	const tag = local.indexOf("+");
	if (tag >= 0) local = local.slice(0, tag);
	if (domain === "googlemail.com") domain = "gmail.com";
	// Dots fold only on Gmail's own domains; elsewhere they are part of the
	// address. A tag folds anywhere, because it delivers to the same mailbox.
	if (domain === "gmail.com") local = local.replaceAll(".", "");
	return `${local}@${domain}`;
}

// Who a reply-all goes to. Reply-To wins over From when present; the account
// replying drops out of both lists. Replying to mail this account sent leaves
// no other sender to answer, so the original recipients become the audience —
// and the carbon copies are whoever is left after that, or the same person
// would be addressed twice.
export function replyRecipients(fields: {
	self: string[];
	from: string[];
	to: string[];
	cc: string[];
	replyTo: string[];
}): { to: string[]; cc: string[] } {
	// Mail addressed to a send-as alias is addressed to this account, so every
	// identity it can send from counts as itself: otherwise a reply copies the
	// alias back to the person replying.
	const selves = new Set(fields.self.map(canonicalAddress));
	const notSelf = (a: string) => !selves.has(canonicalAddress(a));
	// An address wider than a header line has nowhere to fold and cannot be
	// sent. It arrived from the sender, and RFC 5321 caps a local part at 64
	// octets, so it reaches no mailbox either: the reply goes to everyone else
	// rather than failing for all of them.
	const usable = (a: string) => notSelf(a) && fitsHeaderLine(a);
	const primary = (fields.replyTo.length > 0 ? fields.replyTo : fields.from).filter(usable);
	const to = primary.length > 0 ? primary : fields.to.filter(usable);
	// Whether an address is this account is judged by where mail lands, but the
	// overlap between To and Cc is judged as written: a tag is how its owner
	// sorts their own mail, and folding it away would drop them from the reply.
	const addressed = new Set(to.map((a) => a.trim().toLowerCase()));
	const cc: string[] = [];
	for (const address of [...fields.to, ...fields.cc]) {
		const key = address.trim().toLowerCase();
		if (!usable(address) || addressed.has(key)) continue;
		addressed.add(key);
		cc.push(address);
	}
	return { to, cc };
}

// A subject read from received mail can still hold a line break: Gmail returns
// some notification subjects with a trailing newline. A header built from one
// is refused on the way out, which would leave those messages impossible to
// answer or pass on, so the value is put back on a single line first.
function singleLine(value: string): string {
	return value.replace(/[\r\n]+[ \t]*/g, " ").trim();
}

// Subjects and display names arrive encoded and go back out encoded. Anything
// built from them has to be read back first, or the words are encoded twice and
// the reader sees the markup.
export function replySubject(original: string | undefined): string {
	const s = singleLine(original ?? "");
	return /^\s*re:/i.test(s) ? s : `Re: ${s}`;
}

export function forwardSubject(original: string | undefined): string {
	const s = singleLine(original ?? "");
	return /^\s*(fwd?|fw):/i.test(s) ? s : `Fwd: ${s}`;
}

// The header block Gmail and Thunderbird both put above forwarded content.
export function forwardHeaderBlock(fields: {
	from?: string | undefined;
	date?: string | undefined;
	subject?: string | undefined;
	to?: string | undefined;
	cc?: string | undefined;
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
	from?: string | undefined;
	date?: string | undefined;
	subject?: string | undefined;
	to?: string | undefined;
	cc?: string | undefined;
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

// RFC 2047 encoded words, as they arrive in From and Subject. Anything that is
// not a well-formed word is left exactly as it was.
export function decodeEncodedWords(value: string): string {
	return (
		value
			// Whitespace between two encoded words separates them and is not part of
			// the text (RFC 2047 §6.2). encodeHeader splits long values exactly this
			// way, so leaving it in both corrupts what this module itself wrote and,
			// when the separator is a fold, produces a line break the header guard
			// then refuses.
			.replace(/\?=(?:[ \t]|\r?\n[ \t]+)*(?==\?[\w-]+\?[BbQq]\?)/g, "?=")
			.replace(
				/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g,
				(word, charset: string, encoding: string, text: string) => {
					try {
						const bytes =
							encoding.toUpperCase() === "B"
								? Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))
								: Uint8Array.from(
										text
											.replace(/_/g, " ")
											.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
												String.fromCharCode(Number.parseInt(hex, 16)),
											),
										(ch) => ch.charCodeAt(0),
									);
						return new TextDecoder(charset).decode(bytes);
					} catch {
						return word;
					}
				},
			)
	);
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
	const bare = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
	// One id, with something either side of the @ and no space anywhere in it.
	if (!/^[^\s<>@]+@[^\s<>@]+$/.test(bare)) return null;
	// An id travels literally, so one past the width of a header line cannot be
	// sent; a sender who writes one gets no threading rather than a reply that
	// cannot be built at all.
	if (bare.length + 2 > MAX_HEADER_RUN) return null;
	return `<${bare}>`;
}

export function headerValue(message: GmailMessage | undefined, name: string): string | undefined {
	return message?.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
		?.value;
}

function b64urlToBytes(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function partCharset(part: GmailPart | undefined): string {
	const ct = part?.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value;
	// A parameter may carry whitespace either side of its "=", which a sender
	// writing ISO-2022-JP or Shift_JIS is as free to do as any other. Reading it
	// as UTF-8 returns the escape sequences instead of the text.
	return ct?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1] ?? "utf-8";
}

// Decodes part data honoring its declared charset (ISO-2022-JP and friends);
// unknown charsets fall back to UTF-8.
function decodePartData(part: GmailPart): string {
	const bytes = b64urlToBytes(part.body?.data ?? "");
	try {
		return new TextDecoder(partCharset(part)).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

// The entities that turn up in ordinary mail. Anything else is left as written
// rather than guessed at.
const HTML_ENTITIES: Record<string, string> = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	pound: "£",
	euro: "€",
	yen: "¥",
	copy: "©",
	reg: "®",
	trade: "™",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	middot: "·",
	bull: "•",
	deg: "°",
	times: "×",
	divide: "÷",
};

// A numeric reference names a code point, and a sender may name one that is not
// a character: past the Unicode range, or inside the surrogate block. Those are
// left as written rather than thrown over.
function codePoint(original: string, value: number): string {
	if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return original;
	if (value >= 0xd800 && value <= 0xdfff) return original;
	return String.fromCodePoint(value);
}

function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#(\d+);/g, (match, code: string) => codePoint(match, Number(code)))
		.replace(/&#[xX]([0-9a-fA-F]+);/g, (match, hex: string) =>
			codePoint(match, Number.parseInt(hex, 16)),
		)
		.replace(
			/&(nbsp|amp|lt|gt|quot|apos|pound|euro|yen|copy|reg|trade|mdash|ndash|hellip|laquo|raquo|lsquo|rsquo|ldquo|rdquo|middot|bull|deg|times|divide);/g,
			(match, name: string) => HTML_ENTITIES[name] ?? match,
		)
		.replace(/\s{3,}/g, "\n")
		.trim();
}

// Walks the MIME tree and returns the first text/plain part, falling back to
// text/html with tags stripped.
// A part carrying a filename, or marked attachment by its disposition, is a
// file the sender enclosed rather than the message they wrote. Reading one as
// the body shows the wrong content and quotes it into replies and forwards,
// and the order parts arrive in is the sender's to choose.
function isBodyPart(part: GmailPart): boolean {
	const disposition =
		part?.headers?.find((h) => h?.name?.toLowerCase() === "content-disposition")?.value ?? "";
	// A filename usually marks an attachment, but a part that says inline is
	// part of the message however it is named.
	if (part.filename && !/^\s*inline/i.test(disposition)) return false;
	// An enclosed message brings a whole message with it. Its parts belong to
	// that message, whether or not the enclosure was marked as an attachment.
	const type = part.mimeType?.toLowerCase() ?? "";
	if (type.startsWith("message/") || type === "multipart/digest") return false;
	return !/^\s*attachment/i.test(disposition);
}

// Walks only what the sender wrote. An enclosed message brings its own text
// parts, and those carry no filename or disposition of their own, so judging
// each part in a flattened list would let them pass; the walk stops at the
// enclosure instead of looking inside it.
function bodyParts(payload: GmailPart | undefined): GmailPart[] {
	const out: GmailPart[] = [];
	const walk = (p: GmailPart | undefined) => {
		if (!p || !isBodyPart(p)) return;
		out.push(p);
		for (const child of p.parts ?? []) walk(child);
	};
	walk(payload);
	return out;
}

export function extractBody(payload: GmailPart | undefined): string {
	const parts = bodyParts(payload);

	const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
	if (plain) return decodePartData(plain);

	const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
	if (html) return htmlToText(decodePartData(html));

	return "";
}

// The HTML alternative as the sender wrote it, markup intact. extractBody
// strips the tags because it answers a reader; a rebuild has to carry the
// part itself, or a draft edited once would lose its formatting.
export function extractHtmlBody(payload: GmailPart | undefined): string {
	const html = bodyParts(payload).find((p) => p.mimeType === "text/html" && p.body?.data);
	return html ? decodePartData(html) : "";
}

// Where a part's bytes are found when a message is rebuilt: externalised parts
// carry an id to fetch, small ones arrive whole in data.
type PartBytes = {
	contentType: string;
	attachmentId: string;
	data: string;
	size: number;
};
export type DraftFileRef = PartBytes & { filename: string };
export type DraftInlineRef = PartBytes & { cid: string };

// The enclosed parts a rebuilt message has to keep: its files, and the images
// its HTML shows by cid. The two leave differently — a file re-attaches under
// its name, an image under its Content-ID — and a part that carries both a
// name and a cid is the image, or rebuilding would turn it into a plain file
// and every <img> pointing at it would break.
function partBytes(p: GmailPart): PartBytes | null {
	if (p.body?.attachmentId === undefined && p.body?.data === undefined) return null;
	return {
		contentType: p.mimeType ?? "application/octet-stream",
		attachmentId: p.body?.attachmentId ?? "",
		data: p.body?.data ?? "",
		size: p.body?.size ?? 0,
	};
}

function partCid(p: GmailPart): string | undefined {
	return p.headers
		?.find((h) => h.name?.toLowerCase() === "content-id")
		?.value?.replace(/^\s*<|>\s*$/g, "");
}

export function draftContentParts(payload: GmailPart | undefined): {
	files: DraftFileRef[];
	inline: DraftInlineRef[];
} {
	const files: DraftFileRef[] = [];
	const inline: DraftInlineRef[] = [];
	const walk = (p: GmailPart | undefined) => {
		if (!p) return;
		const type = (p.mimeType ?? "").toLowerCase();
		const bytes = partBytes(p);
		const cid = partCid(p);
		if (bytes && cid && type.startsWith("image/")) {
			inline.push({ ...bytes, cid });
		} else if (bytes && p.filename) {
			files.push({ ...bytes, filename: p.filename });
		}
		// A message enclosed as a file travels whole through its own part; the
		// parts inside it would arrive a second time.
		if (type.startsWith("message/") || type === "multipart/digest") return;
		for (const child of p.parts ?? []) walk(child);
	};
	walk(payload);
	return { files, inline };
}

// A References chain as it can be sent on: only ids a receiver can thread on
// survive, with the answered message's own id appended when a reply extends
// the chain. Every id in it arrived from a sender, and one that fails the
// same check as In-Reply-To threads nothing on the receiving end.
export function sanitizeReferences(
	chain: string | undefined,
	append?: string | null,
): string | undefined {
	const ids = [...(chain ?? "").split(/\s+/).map(normalizeMessageId), append ?? null].filter(
		Boolean,
	);
	return ids.length > 0 ? ids.join(" ") : undefined;
}

// Gmail stores large text parts as attachments (body.attachmentId, no data);
// callers fetch those bytes separately and decode here.
export function textPartAttachment(
	payload: GmailPart | undefined,
): { attachmentId: string; mimeType: string; charset: string; size: number } | null {
	const bodies = bodyParts(payload);
	const part =
		bodies.find((p) => p.mimeType === "text/plain" && p.body?.attachmentId) ??
		bodies.find((p) => p.mimeType === "text/html" && p.body?.attachmentId);
	if (!part) return null;
	return {
		attachmentId: part.body?.attachmentId ?? "",
		mimeType: part.mimeType ?? "text/plain",
		charset: partCharset(part),
		// Gmail reports the decoded byte count, which is what decides whether
		// this part is worth fetching at all.
		size: part.body?.size ?? 0,
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

export function summarizeMessage(m: GmailMessage) {
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
