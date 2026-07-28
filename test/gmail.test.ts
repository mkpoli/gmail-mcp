import { afterEach, describe, expect, test } from "bun:test";
import {
	b64urlEncode,
	b64urlToStandard,
	buildRfc822,
	canonicalAddress,
	decodeAttachmentText,
	decodeEncodedWords,
	encodedSize,
	escapeHtml,
	extractBody,
	forwardHeaderBlock,
	forwardHtmlBlock,
	forwardSubject,
	GmailApiError,
	type GmailPart,
	gmailFetch,
	headerValue,
	normalizeMessageId,
	parseAddresses,
	partCharset,
	quoteHtml,
	quotePlain,
	replyRecipients,
	replySubject,
	summarizeMessage,
	textPartAttachment,
	truncate,
} from "../src/gmail";

// The encoder's counterpart, kept here because nothing in the Worker decodes
// base64url — these tests are its only caller.
function b64urlDecode(s: string): string {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

describe("b64url", () => {
	test("round-trips ASCII", () => {
		expect(b64urlDecode(b64urlEncode("hello world"))).toBe("hello world");
	});

	test("round-trips UTF-8", () => {
		const s = "件名テスト sample text 🐟";
		expect(b64urlDecode(b64urlEncode(s))).toBe(s);
	});

	test("uses URL-safe alphabet without padding", () => {
		const encoded = b64urlEncode("\xff\xfe?>~~~");
		expect(encoded).not.toMatch(/[+/=]/);
	});

	test("decodes Gmail-style unpadded input", () => {
		expect(b64urlDecode("aGVsbG8")).toBe("hello");
	});
});

describe("buildRfc822", () => {
	test("includes required headers and base64 body", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "Hi", body: "line1\nline2" });
		const lines = raw.split("\r\n");
		expect(lines).toContain("To: a@example.com");
		expect(lines).toContain("Subject: Hi");
		expect(lines).toContain("MIME-Version: 1.0");
		const body = lines[lines.length - 1] ?? "";
		expect(atob(body)).toBe("line1\nline2");
	});

	test("omits optional headers when absent", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "s", body: "b" });
		expect(raw).not.toContain("Cc:");
		expect(raw).not.toContain("Bcc:");
		expect(raw).not.toContain("In-Reply-To:");
	});

	test("adds cc, bcc, and reply threading headers", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			cc: "c@example.com",
			bcc: "d@example.com",
			subject: "s",
			body: "b",
			inReplyTo: "<msg-id@mail.gmail.com>",
			references: "<msg-id@mail.gmail.com>",
		});
		expect(raw).toContain("Cc: c@example.com");
		expect(raw).toContain("Bcc: d@example.com");
		expect(raw).toContain("In-Reply-To: <msg-id@mail.gmail.com>");
		expect(raw).toContain("References: <msg-id@mail.gmail.com>");
	});

	test("RFC 2047-encodes non-ASCII subjects", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "こんにちは", body: "b" });
		const subject = raw.split("\r\n").find((l) => l.startsWith("Subject:"));
		expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/);
		const b64 = subject?.match(/=\?UTF-8\?B\?(.+)\?=/)?.[1] ?? "";
		const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
		expect(decoded).toBe("こんにちは");
	});

	test("keeps ASCII subjects unencoded", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "plain subject", body: "b" });
		expect(raw).toContain("Subject: plain subject");
	});

	test("rejects CRLF injection in every header field", () => {
		const evil = "x@example.com\r\nBcc: attacker@evil.com";
		expect(() => buildRfc822({ to: evil, subject: "s", body: "b" })).toThrow(/To header/);
		expect(() => buildRfc822({ to: "a@example.com", cc: evil, subject: "s", body: "b" })).toThrow(
			/Cc header/,
		);
		expect(() => buildRfc822({ to: "a@example.com", subject: "s\nX-Evil: 1", body: "b" })).toThrow(
			/Subject header/,
		);
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				inReplyTo: "<x@y>\r\nBcc: attacker@evil.com",
			}),
		).toThrow(/In-Reply-To header/);
	});

	test("handles bodies past the fromCharCode argument limit", () => {
		const body = "長い本文の一行\n".repeat(20_000);
		const raw = buildRfc822({ to: "a@example.com", subject: "big", body });
		const encoded = (raw.split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, "");
		expect(b64urlDecode(encoded.replace(/\+/g, "-").replace(/\//g, "_"))).toBe(body);
	});

	test("builds multipart/alternative when htmlBody is given", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "plain version",
			htmlBody: "<h1>rich version</h1>",
		});
		const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
		expect(boundary).toBeTruthy();
		expect(raw).toContain(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		const parts = raw.split(`--${boundary}`);
		expect(parts.length).toBe(4);
		expect(parts[1] ?? "").toContain('Content-Type: text/plain; charset="UTF-8"');
		expect(atob((parts[1] ?? "").trim().split("\r\n").pop() ?? "")).toBe("plain version");
		expect(parts[2] ?? "").toContain('Content-Type: text/html; charset="UTF-8"');
		expect(atob((parts[2] ?? "").trim().split("\r\n").pop() ?? "")).toBe("<h1>rich version</h1>");
		expect((parts[3] ?? "").trim()).toBe("--");
	});

	test("nests mixed > related > alternative for attachments plus inline images", () => {
		const png = btoa("fake-png-bytes");
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "plain",
			htmlBody: '<img src="cid:logo1">',
			attachments: [{ filename: "データ.csv", contentType: "text/csv", content: btoa("a,b") }],
			inlineImages: [{ cid: "logo1", contentType: "image/png", content: png }],
		});
		const mixedAt = raw.indexOf("multipart/mixed");
		const relatedAt = raw.indexOf("multipart/related");
		const altAt = raw.indexOf("multipart/alternative");
		expect(mixedAt).toBeGreaterThan(-1);
		expect(relatedAt).toBeGreaterThan(mixedAt);
		expect(altAt).toBeGreaterThan(relatedAt);
		expect(raw).toContain("Content-ID: <logo1>");
		expect(raw).toContain("Content-Disposition: inline");
		expect(raw).toContain("Content-Disposition: attachment");
		expect(raw).toContain("=?UTF-8?B?");
		expect(raw).toContain(png);
	});

	test("rejects malformed attachment base64 and unsafe cids", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{ filename: "x.bin", contentType: "application/octet-stream", content: "not base64!!" },
				],
			}),
		).toThrow(/base64/);
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				htmlBody: "<p>x</p>",
				inlineImages: [{ cid: "evil>\r\nX: 1", contentType: "image/png", content: btoa("x") }],
			}),
		).toThrow();
	});

	// The part is reachable only through <img src="cid:...">, so a non-image type
	// would be an extra inline body part smuggled past the alternative parts.
	test("rejects an inline image that is not an image", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				htmlBody: '<img src="cid:c1">',
				inlineImages: [{ cid: "c1", contentType: "text/html", content: btoa("<b>x</b>") }],
			}),
		).toThrow(/image/);
	});

	test("requires htmlBody when inline images are present", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				inlineImages: [{ cid: "c1", contentType: "image/png", content: btoa("x") }],
			}),
		).toThrow(/htmlBody/);
	});

	test("RFC 2047-encodes non-ASCII display names in address headers", () => {
		const raw = buildRfc822({
			to: '"田中太郎" <t@example.com>, Plain Name <p@example.org>',
			subject: "s",
			body: "b",
		});
		const header = raw.split("\r\n").find((l) => l.startsWith("To:")) ?? "";
		expect(header).toContain("=?UTF-8?B?");
		expect(header).toContain("<t@example.com>");
		// An ASCII display name stays readable.
		expect(header).toContain("Plain Name <p@example.org>");
		// The address list survives a comma inside the quoted name.
		expect(header.split("<").length - 1).toBe(2);
	});

	test("does not double-escape an already-quoted display name", () => {
		// RFC 5322 quoted-pair: the source already escapes the inner quote
		const raw = buildRfc822({
			to: '"O\\"Brien, Pat" <p@example.com>',
			subject: "s",
			body: "b",
		});
		const header = raw.split("\r\n").find((l) => l.startsWith("To:")) ?? "";
		expect(header).toBe('To: "O\\"Brien, Pat" <p@example.com>');
	});

	test("folds long headers under the RFC 5322 line limit", () => {
		const many = Array.from({ length: 60 }, (_, i) => `person${i}@example.com`).join(", ");
		const subject = `Re: ${"project update ".repeat(80)}`;
		const raw = buildRfc822({ to: many, subject, body: "b" });
		for (const line of raw.split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(998);
		}
		// every recipient survives the fold
		const unfolded = raw.replace(/\r\n[ \t]/g, " ");
		const to = unfolded.split("\r\n").find((l) => l.startsWith("To:")) ?? "";
		expect(to.match(/person\d+@example\.com/g)?.length).toBe(60);
		const subjectLine = unfolded.split("\r\n").find((l) => l.startsWith("Subject:")) ?? "";
		expect(subjectLine).toContain("project update");
	});

	test("keeps bare addresses untouched", () => {
		const raw = buildRfc822({ to: "a@example.com, b@example.org", subject: "s", body: "b" });
		expect(raw).toContain("To: a@example.com, b@example.org");
	});

	test("folds long encoded subjects into 75-octet words", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "日本語".repeat(40), body: "b" });
		const lines = raw.split("\r\n");
		const start = lines.findIndex((l) => l.startsWith("Subject:"));
		const words = [lines[start] ?? "", ...lines.slice(start + 1).filter((l) => l.startsWith(" "))]
			.map((w) => w.trimStart().replace(/^Subject:\s*/, ""))
			.filter(Boolean);
		expect(words.length).toBeGreaterThan(1);
		// The 75-octet ceiling applies to the encoded-word itself.
		for (const word of words) {
			expect(word.length).toBeLessThanOrEqual(75);
		}
		// Every word decodes, so no multi-byte character was cut in half.
		const decoded = words
			.map((w) => w.match(/=\?UTF-8\?B\?(.+)\?=/)?.[1] ?? "")
			.map((b64) =>
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
					Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
				),
			)
			.join("");
		expect(decoded).toBe("日本語".repeat(40));
	});

	test("uses RFC 2231 for a non-ASCII attachment filename", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "b",
			attachments: [{ filename: "請求書.csv", contentType: "text/csv", content: btoa("a,b") }],
		});
		// Percent-encoded UTF-8 in the disposition, RFC 2047 word in the legacy name.
		expect(raw).toContain("filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8");
		expect(raw).toMatch(/Content-Type: text\/csv; name="=\?UTF-8\?B\?/);
	});

	// A filesystem allows a 255-byte name, which is 85 kana. Percent-encoding
	// spends three characters a byte, so the disposition parameter is long
	// while the legacy name parameter beside it stays short; measuring the two
	// together refused names this size on ordinary Japanese and Chinese mail.
	test("sends an attachment named to the filesystem limit", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "b",
			attachments: [{ filename: "あ".repeat(85), contentType: "text/csv", content: btoa("a,b") }],
		});
		const longest = Math.max(
			...raw.split("\r\n").map((line) => new TextEncoder().encode(line).length),
		);
		expect(longest).toBeLessThanOrEqual(998);
	});

	// An encoded word folds itself, and everything after that fold still has to
	// be folded: a long recipient list behind a non-ASCII display name has no
	// break in it otherwise and runs past what a line may carry.
	test("folds a recipient list that follows an encoded display name", () => {
		const raw = buildRfc822({
			to: [
				"株式会社サンプル 営業部 田中太郎 <tanaka@example.co.jp>",
				...Array.from({ length: 60 }, (_, i) => `person${i}@example.com`),
			].join(", "),
			subject: "s",
			body: "b",
		});
		const longest = Math.max(
			...raw.split("\r\n").map((line) => new TextEncoder().encode(line).length),
		);
		expect(longest).toBeLessThanOrEqual(998);
	});

	test("keeps a plain filename unencoded", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "b",
			attachments: [{ filename: "report.csv", contentType: "text/csv", content: btoa("a,b") }],
		});
		expect(raw).toContain('Content-Disposition: attachment; filename="report.csv"');
		expect(raw).not.toContain("filename*=");
	});

	test("rejects a content type carrying extra parameters", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{
						filename: "safe.txt",
						contentType: 'text/plain; name="spoofed.exe"',
						content: btoa("x"),
					},
				],
			}),
		).toThrow(/invalid content type/);
	});

	test("includes a From header for send-as aliases", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			from: "alias@example.org",
			subject: "s",
			body: "b",
		});
		expect(raw).toContain("From: alias@example.org");
	});

	test("stays single-part text/plain without htmlBody", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "s", body: "b" });
		expect(raw).not.toContain("multipart/alternative");
		expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
	});

	test("wraps encoded body lines at 76 characters", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "s", body: "x".repeat(600) });
		const bodyLines = (raw.split("\r\n\r\n")[1] ?? "").split("\r\n");
		expect(bodyLines.length).toBeGreaterThan(1);
		for (const line of bodyLines) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
	});
});

describe("extractBody", () => {
	const part = (mimeType: string, text: string, parts?: GmailPart[]) => ({
		mimeType,
		body: { data: b64urlEncode(text) },
		parts,
	});

	test("returns text/plain part directly", () => {
		expect(extractBody(part("text/plain", "plain body"))).toBe("plain body");
	});

	test("prefers text/plain in multipart/alternative", () => {
		const payload = {
			mimeType: "multipart/alternative",
			parts: [part("text/plain", "the plain one"), part("text/html", "<p>the html one</p>")],
		};
		expect(extractBody(payload)).toBe("the plain one");
	});

	test("finds text/plain nested in multipart/mixed", () => {
		const payload = {
			mimeType: "multipart/mixed",
			parts: [
				{
					mimeType: "multipart/alternative",
					parts: [part("text/plain", "deeply nested")],
				},
			],
		};
		expect(extractBody(payload)).toBe("deeply nested");
	});

	test("strips tags, styles, and entities from HTML fallback", () => {
		const html = `<style>p{color:red}</style><script>alert(1)</script><p>Hello &amp; &lt;world&gt;&nbsp;!</p>`;
		expect(extractBody(part("text/html", html))).toBe("Hello & <world> !");
	});

	test("returns empty string when no textual part exists", () => {
		expect(extractBody({ mimeType: "image/png", body: {} })).toBe("");
		expect(extractBody(undefined)).toBe("");
	});

	test("honors a declared non-UTF-8 charset", () => {
		const text = "日本語テスト";
		// Shift_JIS bytes for the text above.
		const sjisBytes = new Uint8Array([
			0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67,
		]);
		let bin = "";
		for (const b of sjisBytes) bin += String.fromCharCode(b);
		const data = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
		const payload = {
			mimeType: "text/plain",
			headers: [{ name: "Content-Type", value: 'text/plain; charset="Shift_JIS"' }],
			body: { data },
		};
		expect(extractBody(payload)).toBe(text);
	});
});

describe("a subject that arrives carrying a line break", () => {
	// Gmail returns some notification subjects with a trailing newline — Search
	// Console does it on every message — and a header built from one is refused
	// on the way out, leaving those messages impossible to answer or pass on.
	const live = "サイト aynu.org のページがインデックスに登録されない新しい要因\n";

	test("replies to it", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: replySubject(live), body: "b" });
		expect(raw).toContain("Subject: ");
	});

	test("forwards it", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: forwardSubject(live), body: "b" });
		expect(raw).toContain("Subject: ");
	});

	test("keeps an ordinary subject as it was", () => {
		expect(replySubject("Quarterly report")).toBe("Re: Quarterly report");
		expect(forwardSubject("Re: Quarterly report")).toBe("Fwd: Re: Quarterly report");
	});
});

describe("a display name too long to fold", () => {
	// A name carrying a comma is quoted, and the folder never breaks inside a
	// quoted string. Judging it by its spaces called it foldable while the
	// folder kept it whole, and the line written had nowhere to break.
	test("refuses one that would run past the limit", () => {
		const name = `Doe, ${Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ")}`;
		expect(() => buildRfc822({ to: `"${name}" <x@example.com>`, subject: "s", body: "b" })).toThrow(
			/too long to fit a header line/,
		);
	});

	test("keeps sending an ordinary quoted name", () => {
		const raw = buildRfc822({
			to: '"Smith, John Q." <john@example.com>, "O\'Brien, Ann" <ann@example.com>',
			subject: "s",
			body: "b",
		});
		const longest = Math.max(
			...raw.split("\r\n").map((line) => new TextEncoder().encode(line).length),
		);
		expect(longest).toBeLessThanOrEqual(998);
		expect(raw).toContain("Smith, John Q.");
	});
});

describe("a header value whose quotes do not balance", () => {
	// Folding keeps a quoted string whole, so one stray quote used to swallow
	// everything after it into a string with no end and no place to break.
	test("folds a long subject carrying a single stray quote", () => {
		const subject = `"${Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")}`;
		const raw = buildRfc822({ to: "a@example.com", subject, body: "b" });
		const longest = Math.max(
			...raw.split("\r\n").map((line) => new TextEncoder().encode(line).length),
		);
		expect(longest).toBeLessThanOrEqual(998);
	});

	test("keeps a balanced quoted display name on one line", () => {
		const raw = buildRfc822({
			to: '"Smith, John Q. Public" <john@example.com>',
			subject: "s",
			body: "b",
		});
		expect(raw).toContain('"Smith, John Q. Public"');
	});
});

describe("a long recipient list written without spaces", () => {
	// The list is rejoined with ", " before it is written, so it folds at every
	// address. Measuring what the caller typed refused a bare-comma list for
	// having no space in it, while the header built from it had one throughout.
	const list = (n: number, separator: string) =>
		Array.from({ length: n }, (_, i) => `r${i}@example.com`).join(separator);

	test("sends whether or not the commas are followed by a space", () => {
		for (const separator of [",", ", "]) {
			const raw = buildRfc822({ to: list(70, separator), subject: "s", body: "b" });
			const longest = Math.max(...raw.split("\r\n").map((line) => line.length));
			expect(longest).toBeLessThanOrEqual(998);
		}
	});

	test("applies to Cc and Bcc too", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			cc: list(70, ","),
			bcc: list(70, ","),
			subject: "s",
			body: "b",
		});
		expect(raw).toContain("Cc: ");
		expect(raw).toContain("Bcc: ");
	});

	// One address with nowhere to fold still cannot be sent.
	test("still refuses a single address too wide for a line", () => {
		expect(() =>
			buildRfc822({ to: `${"x".repeat(963)}@example.com`, subject: "s", body: "b" }),
		).toThrow(/too long to fit a header line/);
	});
});

describe("a message addressed only by Bcc", () => {
	// The builder admits mail that names no To, and an announcement sent
	// privately to a list is ordinary mail. What went out was an empty field,
	// which RFC 5322 §3.6.3 does not allow.
	test("leaves the To field out rather than writing it empty", () => {
		const raw = buildRfc822({ to: "", bcc: "a@example.com", subject: "s", body: "b" });
		expect(raw).not.toContain("To: \r\n");
		expect(raw).toContain("Bcc: a@example.com");
	});

	test("still writes To when there is one", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			cc: "c@example.com",
			subject: "s",
			body: "b",
		});
		expect(raw).toContain("To: a@example.com");
	});
});

describe("partCharset", () => {
	// A sender may put whitespace either side of a parameter's "=", and reading
	// the part as UTF-8 hands back the escape sequences rather than the text.
	test("reads a charset written with spaces around the equals", () => {
		const of = (value: string) =>
			partCharset({ headers: [{ name: "Content-Type", value }] } as never);
		expect(of("text/plain; charset=ISO-2022-JP")).toBe("ISO-2022-JP");
		expect(of("text/plain; charset = ISO-2022-JP")).toBe("ISO-2022-JP");
		expect(of('text/plain; charset = "Shift_JIS"')).toBe("Shift_JIS");
		expect(of("text/plain")).toBe("utf-8");
	});
});

describe("textPartAttachment / decodeAttachmentText / truncate", () => {
	test("finds an externalized text part, skipping file attachments", () => {
		const payload = {
			mimeType: "multipart/mixed",
			parts: [
				{
					mimeType: "text/plain",
					filename: "log.txt",
					body: { attachmentId: "file-att" },
				},
				{
					mimeType: "text/plain",
					filename: "",
					headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
					body: { attachmentId: "body-att", size: 4096 },
				},
			],
		};
		expect(textPartAttachment(payload)).toEqual({
			attachmentId: "body-att",
			mimeType: "text/plain",
			charset: "utf-8",
			size: 4096,
		});
	});

	// The size decides whether the part is fetched at all, so an absent one has
	// to read as zero rather than as undefined.
	test("reports zero when Gmail omits the part size", () => {
		const payload = {
			mimeType: "text/plain",
			filename: "",
			body: { attachmentId: "body-att" },
		};
		expect(textPartAttachment(payload)?.size).toBe(0);
	});

	test("returns null when every part is inline", () => {
		expect(textPartAttachment({ mimeType: "text/plain", body: { data: "aGk" } })).toBeNull();
	});

	test("decodes attachment text and strips HTML when needed", () => {
		const data = b64urlEncode("<p>Hello</p>");
		expect(decodeAttachmentText(data, "text/html", "utf-8")).toBe("Hello");
		expect(decodeAttachmentText(b64urlEncode("plain"), "text/plain", "utf-8")).toBe("plain");
	});

	test("truncate caps long text with a marker and passes short text through", () => {
		expect(truncate("short", 100)).toBe("short");
		const cut = truncate("a".repeat(150), 100);
		expect(cut).toContain("a".repeat(100));
		expect(cut).toContain("[truncated: 50 of 150 characters omitted]");
	});

	// A cut that lands between the two halves of an astral character leaves a
	// lone surrogate, which survives JSON but not UTF-8 encoding — and a quoted
	// body goes on to be sent as mail.
	test("truncate never splits a surrogate pair", () => {
		const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		const text = `${"あ".repeat(3)}👍${"b".repeat(10)}`;
		for (let limit = 1; limit < text.length; limit++) {
			expect(truncate(text, limit)).not.toMatch(lone);
		}
	});

	test("truncate reports the number of characters it actually dropped", () => {
		const text = `${"あ".repeat(3)}👍${"b".repeat(10)}`;
		// The limit falls inside the emoji, so the cut retreats to before it.
		expect(truncate(text, 4)).toBe(`${"あ".repeat(3)}\n[truncated: 12 of 15 characters omitted]`);
	});
});

describe("reply helpers", () => {
	test("parseAddresses handles display names with commas and bare addresses", () => {
		expect(parseAddresses('"Doe, John" <j@example.com>, Jane <jane@example.org>')).toEqual([
			"j@example.com",
			"jane@example.org",
		]);
		expect(parseAddresses("solo@example.com")).toEqual(["solo@example.com"]);
		expect(parseAddresses("a@example.com, b@example.org")).toEqual([
			"a@example.com",
			"b@example.org",
		]);
		expect(parseAddresses(undefined)).toEqual([]);
		expect(parseAddresses("A <x@example.com>, B <x@example.com>")).toEqual(["x@example.com"]);
	});

	test("parseAddresses survives escaped quotes and comments", () => {
		expect(parseAddresses('"O\\"Brien, Pat" <p@example.com>, Ann <a@example.org>')).toEqual([
			"p@example.com",
			"a@example.org",
		]);
		expect(parseAddresses("(a comment, with comma) solo@example.com")).toEqual([
			"solo@example.com",
		]);
	});

	test("forwardSubject prefixes once", () => {
		expect(forwardSubject("Hello")).toBe("Fwd: Hello");
		expect(forwardSubject("Fwd: Hello")).toBe("Fwd: Hello");
		expect(forwardSubject("FW: Hello")).toBe("FW: Hello");
	});

	test("forward blocks carry the original envelope and escape HTML", () => {
		const fields = {
			from: "A <a@example.com>",
			date: "Fri, 25 Jul 2026",
			subject: "Original",
			to: "b@example.org",
		};
		const text = forwardHeaderBlock(fields);
		expect(text).toContain("---------- Forwarded message ---------");
		expect(text).toContain("From: A <a@example.com>");
		const html = forwardHtmlBlock({ ...fields, body: "<script>x</script>" });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("replySubject prefixes once", () => {
		expect(replySubject("Hello")).toBe("Re: Hello");
		expect(replySubject("Re: Hello")).toBe("Re: Hello");
		expect(replySubject("RE: Hello")).toBe("RE: Hello");
		expect(replySubject(undefined)).toBe("Re: ");
	});

	test("quotePlain prefixes every line", () => {
		expect(quotePlain("A <a@example.com>", "Fri, 25 Jul 2026", "line1\nline2")).toBe(
			"On Fri, 25 Jul 2026, A <a@example.com> wrote:\n> line1\n> line2",
		);
	});

	test("quoteHtml escapes injected markup from the original mail", () => {
		const html = quoteHtml("<script>x</script>", "d", "body with <b>tags</b> & ampersand");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;b&gt;tags&lt;/b&gt; &amp; ampersand");
		expect(html).toContain("<blockquote");
	});

	test("escapeHtml covers the four metacharacters", () => {
		expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
	});
});

describe("normalizeMessageId", () => {
	test("passes a well-formed msg-id through", () => {
		expect(normalizeMessageId("<CAB123@mail.gmail.com>")).toBe("<CAB123@mail.gmail.com>");
	});

	test("adds the angle brackets RFC 5322 requires", () => {
		expect(normalizeMessageId("CAB123@mail.gmail.com")).toBe("<CAB123@mail.gmail.com>");
		expect(normalizeMessageId("  CAB123@mail.gmail.com  ")).toBe("<CAB123@mail.gmail.com>");
	});

	// The Gmail API's own message id has no "@" and threads nothing; the caller
	// has to resolve it to the header value instead of sending it as-is.
	test("reports a Gmail API id as needing resolution", () => {
		expect(normalizeMessageId("1932a1b2c3d4e5f6")).toBeNull();
		expect(normalizeMessageId("")).toBeNull();
	});

	// A sender chooses their own Message-ID, and one too wide to fold onto a
	// header line would otherwise reach the builder and fail every reply.
	test("rejects an id too long for a header line", () => {
		expect(normalizeMessageId(`<${"x".repeat(950)}@example.com>`)).toBeNull();
		expect(normalizeMessageId(`<${"x".repeat(870)}@example.com>`)).toBe(
			`<${"x".repeat(870)}@example.com>`,
		);
	});
});

describe("headerValue / summarizeMessage", () => {
	const message = {
		id: "m1",
		threadId: "t1",
		labelIds: ["INBOX", "UNREAD"],
		snippet: "snippet text",
		payload: {
			headers: [
				{ name: "From", value: "Sender <s@example.com>" },
				{ name: "SUBJECT", value: "case test" },
				{ name: "Date", value: "Fri, 25 Jul 2026 10:00:00 +0900" },
			],
		},
	};

	test("matches header names case-insensitively", () => {
		expect(headerValue(message, "subject")).toBe("case test");
		expect(headerValue(message, "From")).toBe("Sender <s@example.com>");
	});

	test("returns undefined for absent headers", () => {
		expect(headerValue(message, "To")).toBeUndefined();
		expect(headerValue({}, "From")).toBeUndefined();
	});

	test("summarizes the fields tools rely on", () => {
		expect(summarizeMessage(message)).toEqual({
			id: "m1",
			threadId: "t1",
			labelIds: ["INBOX", "UNREAD"],
			snippet: "snippet text",
			from: "Sender <s@example.com>",
			to: undefined,
			cc: undefined,
			date: "Fri, 25 Jul 2026 10:00:00 +0900",
			subject: "case test",
		});
	});

	test("reports who was copied", () => {
		const copied = {
			...message,
			payload: {
				headers: [
					...message.payload.headers,
					{ name: "Cc", value: "Team <team@example.com>, b@example.org" },
				],
			},
		};
		expect(summarizeMessage(copied).cc).toBe("Team <team@example.com>, b@example.org");
	});
});

describe("gmailFetch", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function stub(
		response: Response,
		seen: { url?: string | undefined; init?: RequestInit | undefined } = {},
	) {
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			seen.url = String(url);
			seen.init = init;
			return response;
		}) as typeof fetch;
		return seen;
	}

	test("sends the token as a bearer against the me/ endpoint", async () => {
		const seen = stub(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
		const body = await gmailFetch("tok-123", "/profile");
		expect(body).toEqual({ ok: 1 });
		expect(seen.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
		const headers = (seen.init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok-123");
	});

	// The status is what decides whether the caller refreshes the token, backs
	// off, or gives up, so it has to survive on the error.
	test("raises the Gmail status as a GmailApiError", async () => {
		stub(new Response("quota exceeded", { status: 429 }));
		try {
			await gmailFetch("tok", "/messages");
			throw new Error("expected a rejection");
		} catch (e) {
			expect(e).toBeInstanceOf(GmailApiError);
			expect((e as GmailApiError).status).toBe(429);
			expect((e as GmailApiError).message).toContain("quota exceeded");
		}
	});

	test("returns nothing for a 204, which carries no body to parse", async () => {
		stub(new Response(null, { status: 204 }));
		expect(await gmailFetch("tok", "/labels/x", { method: "DELETE" })).toBeNull();
	});
});

describe("b64urlToStandard", () => {
	// Gmail strips the padding from the base64url it returns, and the message
	// builder rejects anything that is not a multiple of four.
	test("restores the padding Gmail leaves off", () => {
		for (let len = 1; len <= 12; len++) {
			const bytes = Uint8Array.from({ length: len }, (_, i) => i + 1);
			const standard = btoa(String.fromCharCode(...bytes));
			const asGmailSends = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			expect(b64urlToStandard(asGmailSends)).toBe(standard);
		}
	});

	test("maps the url-safe alphabet back", () => {
		expect(b64urlToStandard("-_8")).toBe("+/8=");
	});

	test("carries a forwarded attachment through the builder", () => {
		const asGmailSends = btoa("five!").replace(/=+$/, "");
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "Fwd",
			body: "b",
			attachments: [
				{
					filename: "report.pdf",
					contentType: "application/pdf",
					content: b64urlToStandard(asGmailSends),
				},
			],
		});
		expect(raw).toContain("Content-Disposition: attachment");
	});
});

describe("replyRecipients", () => {
	const self = "me@example.com";

	test("answers the sender and copies the rest", () => {
		expect(
			replyRecipients({
				self: [self],
				from: ["alice@example.com"],
				to: [self, "bob@example.com"],
				cc: ["carol@example.com"],
				replyTo: [],
			}),
		).toEqual({ to: ["alice@example.com"], cc: ["bob@example.com", "carol@example.com"] });
	});

	// One address wider than a header line reaches no mailbox and cannot be
	// written into one, so it drops out and the others still get the reply.
	test("drops an address too long for a header line", () => {
		expect(
			replyRecipients({
				self: [self],
				from: [`${"x".repeat(950)}@example.com`, "alice@example.com"],
				to: [self, `${"y".repeat(950)}@example.com`, "bob@example.com"],
				cc: [],
				replyTo: [],
			}),
		).toEqual({ to: ["alice@example.com"], cc: ["bob@example.com"] });
	});

	test("prefers Reply-To over From", () => {
		const { to } = replyRecipients({
			self: [self],
			from: ["alice@example.com"],
			to: [self],
			cc: [],
			replyTo: ["list@example.org"],
		});
		expect(to).toEqual(["list@example.org"]);
	});

	// Replying to mail this account sent: the original recipients become the
	// audience, and none of them may also appear as a carbon copy.
	test("never addresses the same person twice", () => {
		const { to, cc } = replyRecipients({
			self: [self],
			from: [self],
			to: ["bob@example.com"],
			cc: ["carol@example.com"],
			replyTo: [],
		});
		expect(to).toEqual(["bob@example.com"]);
		expect(cc).toEqual(["carol@example.com"]);
		expect(to.filter((a) => cc.includes(a))).toEqual([]);
	});

	test("drops the replying account from both lists", () => {
		const { to, cc } = replyRecipients({
			self: [self],
			from: ["alice@example.com"],
			to: [self],
			cc: [self],
			replyTo: [],
		});
		expect(to).not.toContain(self);
		expect(cc).not.toContain(self);
	});
});

describe("extractBody attachment handling", () => {
	const b64 = (s: string) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(s)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	// A text file enclosed with the message is not the message. Reading it as
	// the body would show the wrong content and quote it into replies.
	test("skips a text/plain attachment in favour of the real body", () => {
		expect(
			extractBody({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "text/plain",
						filename: "instructions.txt",
						body: { data: b64("ATTACHMENT-CONTENT") },
					},
					{ mimeType: "text/plain", body: { data: b64("REAL-BODY") } },
				],
			}),
		).toBe("REAL-BODY");
	});

	test("skips a part marked as an attachment by its disposition", () => {
		expect(
			extractBody({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "text/plain",
						headers: [{ name: "Content-Disposition", value: 'attachment; filename="a.txt"' }],
						body: { data: b64("ATTACHMENT-CONTENT") },
					},
					{ mimeType: "text/plain", body: { data: b64("REAL-BODY") } },
				],
			}),
		).toBe("REAL-BODY");
	});

	test("still reads a lone body part that has no filename", () => {
		expect(extractBody({ mimeType: "text/plain", body: { data: b64("just the body") } })).toBe(
			"just the body",
		);
	});
});

describe("canonicalAddress", () => {
	test("folds a plus tag away", () => {
		expect(canonicalAddress("john+alerts@example.com")).toBe("john@example.com");
	});

	// Dots are insignificant on Gmail's own domains and significant everywhere
	// else, so a Workspace address must keep them.
	test("folds dots only on Gmail's own domains", () => {
		expect(canonicalAddress("john.smith@gmail.com")).toBe("johnsmith@gmail.com");
		expect(canonicalAddress("john.smith@googlemail.com")).toBe("johnsmith@gmail.com");
		expect(canonicalAddress("john.smith@company.com")).toBe("john.smith@company.com");
	});

	test("lowercases and leaves an ordinary address alone", () => {
		expect(canonicalAddress("Bob@Example.COM")).toBe("bob@example.com");
	});
});

describe("replyRecipients with aliases", () => {
	test("does not copy the replying account's own plus alias", () => {
		const { to, cc } = replyRecipients({
			self: ["john.smith@gmail.com"],
			from: ["alice@example.com"],
			to: ["john.smith+alerts@gmail.com", "bob@example.com"],
			cc: ["johnsmith@gmail.com"],
			replyTo: [],
		});
		expect(to).toEqual(["alice@example.com"]);
		expect(cc).toEqual(["bob@example.com"]);
	});

	test("keeps a lookalike address on a different domain", () => {
		const { cc } = replyRecipients({
			self: ["john.smith@gmail.com"],
			from: ["alice@example.com"],
			to: ["john.smith@company.com"],
			cc: [],
			replyTo: [],
		});
		expect(cc).toEqual(["john.smith@company.com"]);
	});
});

describe("outgoing size ceiling", () => {
	test("refuses attachments larger than Gmail would accept", () => {
		const huge = "A".repeat(35_000_000);
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{ filename: "big.bin", contentType: "application/octet-stream", content: huge },
				],
			}),
		).toThrow(/ceiling/);
	});

	test("lets an ordinary attachment through", () => {
		const ok = btoa("small file contents");
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [{ filename: "a.txt", contentType: "text/plain", content: ok }],
			}),
		).not.toThrow();
	});
});

describe("recipient and body selection, alias-aware", () => {
	// The overlap between To and Cc has to be judged the same way self is, or an
	// alias of a To recipient still lands in Cc.
	test("does not copy the same address written differently", () => {
		const { to, cc } = replyRecipients({
			self: ["me@example.com"],
			from: ["alice@example.com"],
			to: ["USER@example.com", "bob@example.com"],
			cc: ["user@example.com"],
			replyTo: [],
		});
		expect(to).toEqual(["alice@example.com"]);
		expect(cc).toEqual(["USER@example.com", "bob@example.com"]);
	});

	// A tag is how its owner routes mail; two tagged addresses are different
	// recipients even though they reach one mailbox.
	test("keeps a tagged recipient that is not this account", () => {
		const { cc } = replyRecipients({
			self: ["me@example.com"],
			from: ["alice@example.com"],
			to: ["bob@example.com"],
			cc: ["bob+invoices@example.com"],
			replyTo: [],
		});
		expect(cc).toContain("bob+invoices@example.com");
	});

	// The externalized-body fallback has to judge attachments the same way the
	// inline path does, or a disposition-marked file becomes the body.
	test("does not treat a disposition-marked part as an externalized body", () => {
		expect(
			textPartAttachment({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "text/plain",
						headers: [{ name: "Content-Disposition", value: "attachment" }],
						body: { attachmentId: "file-att", size: 10 },
					},
				],
			}),
		).toBeNull();
	});
});

describe("header line limits and address groups", () => {
	// RFC 5322 §2.1.1 caps a line at 998 octets, and folding can only break at
	// whitespace, so a long unbroken token has to travel as encoded-words —
	// adjacent ones are rejoined without the whitespace that separated them.
	test("keeps every line within 998 octets for an unfoldable subject", () => {
		const raw = buildRfc822({
			to: "a@example.com",
			subject: `https://example.com/${"a".repeat(1200)}`,
			body: "b",
		});
		for (const line of raw.split("\r\n")) {
			expect(line.length).toBeLessThanOrEqual(998);
		}
	});

	test("leaves an ordinary ASCII subject readable", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "Quarterly report", body: "b" });
		expect(raw).toContain("Subject: Quarterly report");
	});

	test("does not carry a group terminator into an address", () => {
		expect(parseAddresses("Team: alice@example.com, bob@example.com;")).toEqual([
			"alice@example.com",
			"bob@example.com",
		]);
		expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
	});
});

describe("threading header length", () => {
	// A msg-id cannot be encoded as words the way a subject can — it has to stay
	// literal — so an over-long one is refused rather than folded into a line
	// past the RFC 5322 limit.
	test("refuses a Message-ID too long to fit a header line", () => {
		const huge = `<${"a".repeat(1200)}@example.com>`;
		expect(() =>
			buildRfc822({ to: "a@example.com", subject: "s", body: "b", inReplyTo: huge }),
		).toThrow(/too long/i);
	});

	test("keeps a References chain within the line limit by folding", () => {
		const chain = Array.from({ length: 40 }, (_, i) => `<msg${i}@example.com>`).join(" ");
		const raw = buildRfc822({
			to: "a@example.com",
			subject: "s",
			body: "b",
			inReplyTo: "<msg39@example.com>",
			references: chain,
		});
		for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
	});
});

describe("an error response the peer chose the size of", () => {
	// Trimming after the fact still means holding whatever arrived. What is
	// counted is what was pulled off the stream, not what was offered.
	test("stops reading a very large error body", async () => {
		let pulled = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						if (pulled >= 256) return controller.close();
						pulled += 1;
						controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
					},
				}),
				{ status: 500 },
			)) as unknown as typeof fetch;
		try {
			await expect(gmailFetch("token", "/messages")).rejects.toThrow(GmailApiError);
			// 16 MiB was on offer.
			expect(pulled).toBeLessThan(8);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("gmailFetch response ceiling", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	// A thread of many large messages is parsed whole before any budget can
	// apply, so an oversized response is refused while it is still a stream.
	test("refuses a response past the ceiling instead of parsing it", async () => {
		const huge = "x".repeat(200);
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (let i = 0; i < 400; i++) controller.enqueue(new TextEncoder().encode(huge));
						controller.close();
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;
		await expect(gmailFetch("tok", "/threads/x", {}, 1000)).rejects.toThrow(/more than/i);
	});

	test("passes an ordinary response through", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as unknown as typeof fetch;
		expect(await gmailFetch<{ ok: number }>("tok", "/profile")).toEqual({ ok: 1 });
	});
});

describe("body selection inside an attached message", () => {
	const b64 = (s: string) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(s)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	// A message enclosed as an attachment brings its own text parts. Reading one
	// as this message's body puts a stranger's mail into replies and forwards.
	const withAttachedMail: GmailPart = {
		mimeType: "multipart/mixed",
		parts: [
			{
				mimeType: "multipart/alternative",
				parts: [{ mimeType: "text/html", body: { data: b64("<p>the real body</p>") } }],
			},
			{
				mimeType: "message/rfc822",
				filename: "forwarded.eml",
				headers: [{ name: "Content-Disposition", value: "attachment" }],
				parts: [{ mimeType: "text/plain", body: { data: b64("someone else's mail") } }],
			},
		],
	};

	test("reads the enclosing message, not the one enclosed", () => {
		expect(extractBody(withAttachedMail)).toBe("the real body");
	});

	test("does not treat an enclosed part as an externalized body", () => {
		expect(
			textPartAttachment({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "message/rfc822",
						filename: "forwarded.eml",
						parts: [{ mimeType: "text/plain", body: { attachmentId: "inner-att", size: 10 } }],
					},
				],
			}),
		).toBeNull();
	});
});

describe("normalizeMessageId strictness", () => {
	// In-Reply-To takes exactly one msg-id (RFC 5322 §3.6.4). Anything else
	// stops the reply threading, silently.
	test.each([
		["two ids", "<a@b> <c@d>"],
		["id plus junk", "<a@b> junk"],
		["empty local part", "<@example.com>"],
		["empty domain", "<user@>"],
		["no id at all", "<>"],
	])("rejects %s", (_name, value) => {
		expect(normalizeMessageId(value)).toBeNull();
	});

	test("still accepts a single well-formed id, bracketed or not", () => {
		expect(normalizeMessageId("<CAB1+2/x@mail.gmail.com>")).toBe("<CAB1+2/x@mail.gmail.com>");
		expect(normalizeMessageId("CAB1@mail.gmail.com")).toBe("<CAB1@mail.gmail.com>");
	});
});

describe("gmailFetch empty responses", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	// Some writes answer with a success and no body. Parsing that as JSON turns
	// a completed action into an error the caller cannot interpret.
	test.each([
		["an empty 200", new Response("", { status: 200 })],
		["a null-bodied 200", new Response(null, { status: 200 })],
		["a 204", new Response(null, { status: 204 })],
	])("returns nothing for %s", async (_name, response) => {
		globalThis.fetch = (async () => response) as unknown as typeof fetch;
		expect(await gmailFetch("tok", "/threads/x/trash", { method: "POST" })).toBeNull();
	});
});

describe("outgoing message ceilings", () => {
	test("refuses a body past the character ceiling", () => {
		expect(() =>
			buildRfc822({ to: "a@example.com", subject: "s", body: "x".repeat(1_000_001) }),
		).toThrow(/may not exceed/);
	});

	test("refuses a message with no recipient", () => {
		expect(() => buildRfc822({ to: "   ", subject: "s", body: "b" })).toThrow(/recipient/);
	});

	// A part's own headers are assembled apart from the message headers, so an
	// over-long filename would never be folded.
	test("refuses an attachment name too long for a header line", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{
						filename: `${"a".repeat(1200)}.pdf`,
						contentType: "application/pdf",
						content: btoa("x"),
					},
				],
			}),
		).toThrow(/too long/);
	});

	test("refuses an address header that cannot be folded", () => {
		expect(() =>
			buildRfc822({ to: `"${"a".repeat(1200)}" <a@example.com>`, subject: "s", body: "b" }),
		).toThrow(/too long/);
	});
});

describe("enclosed messages and encoded words", () => {
	const b64 = (s: string) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(s)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	// An enclosed message need not be marked as an attachment to be one; the
	// media type alone says its parts belong to a different message.
	test("stops at an enclosed message that carries no filename", () => {
		expect(
			extractBody({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "message/rfc822",
						parts: [{ mimeType: "text/plain", body: { data: b64("enclosed text") } }],
					},
					{ mimeType: "text/plain", body: { data: b64("the real body") } },
				],
			}),
		).toBe("the real body");
	});

	test("decodes an encoded word so a quote names the sender", () => {
		expect(decodeEncodedWords("=?UTF-8?B?55Sw5Lit5aSq6YOO?= <t@example.com>")).toBe(
			"田中太郎 <t@example.com>",
		);
		expect(decodeEncodedWords("=?UTF-8?Q?Pat_O=27Brien?=")).toBe("Pat O'Brien");
		expect(decodeEncodedWords("plain text stays")).toBe("plain text stays");
	});

	// The name travels encoded, so its encoded length is what has to fit.
	test("measures an attachment name after encoding, not before", () => {
		expect(() =>
			buildRfc822({
				to: "a@example.com",
				subject: "s",
				body: "b",
				attachments: [
					{ filename: `${"あ".repeat(200)}.csv`, contentType: "text/csv", content: btoa("a,b") },
				],
			}),
		).toThrow(/too long/);
	});
});

describe("recipients a message may carry", () => {
	// RFC 5322 §3.6.3 requires a destination, not a To specifically. A Bcc-only
	// announcement is ordinary mail.
	test("sends with only Bcc", () => {
		const raw = buildRfc822({ to: "", bcc: "hidden@example.com", subject: "s", body: "b" });
		expect(raw).toContain("Bcc: hidden@example.com");
	});

	test("sends with only Cc", () => {
		const raw = buildRfc822({ to: "", cc: "copied@example.com", subject: "s", body: "b" });
		expect(raw).toContain("Cc: copied@example.com");
	});

	test("refuses a message addressed to nobody at all", () => {
		expect(() => buildRfc822({ to: "  ", subject: "s", body: "b" })).toThrow(/at least one/);
	});
});

describe("encodedSize", () => {
	// The forward path bounds a fetch with this; the builder compares the same
	// figure, so the two have to agree or a fetch passes and the build fails.
	test("reports what base64 costs", () => {
		expect(encodedSize(3)).toBe(4);
		expect(encodedSize(2_000_000)).toBe(2_666_668);
		expect(encodedSize(0)).toBe(0);
	});
});

describe("entities a sender controls", () => {
	const b64url = (s: string) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(s)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	const html = (body: string) =>
		extractBody({ mimeType: "text/html", body: { data: b64url(body) } });

	// A code point past the Unicode range, or inside the surrogate block, is not
	// a character. Handing one to fromCodePoint throws, and mail body content is
	// written by whoever sent it.
	test.each([
		["above the range", "&#1114112;"],
		["hex above the range", "&#x110000;"],
		["a lone surrogate", "&#55296;"],
		["absurdly large", "&#99999999999;"],
	])("survives %s", (_name, entity) => {
		expect(() => html(`<p>a${entity}b</p>`)).not.toThrow();
	});

	test("still decodes the ones that are characters", () => {
		expect(html("<p>&#65;&#x42;&pound;</p>")).toBe("AB£");
	});
});

describe("adjacent encoded words", () => {
	const word = (s: string) =>
		`=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

	// RFC 2047 §6.2: whitespace separating two encoded words is not part of the
	// text and a reader drops it. encodeHeader relies on that when it splits a
	// long value, so the two have to agree or this module cannot read its own
	// output back.
	test("drops the whitespace that only separates them", () => {
		expect(decodeEncodedWords(`${word("第三四半期の売上")} ${word("報告書について")}`)).toBe(
			"第三四半期の売上報告書について",
		);
	});

	test("drops a fold between them rather than emitting a line break", () => {
		const decoded = decodeEncodedWords(`${word("abc")}\r\n ${word("def")}`);
		expect(decoded).toBe("abcdef");
		// A line break here would be refused by the header guard, so the send
		// would fail rather than go out wrong.
		expect(decoded).not.toMatch(/[\r\n]/);
	});

	// RFC 5322's obsolete folding allows several folds where one would do, and
	// mail software emits it on long non-ASCII subjects.
	test("drops several folds between them as readily as one", () => {
		expect(decodeEncodedWords(`${word("abc")}\r\n \r\n ${word("def")}`)).toBe("abcdef");
		expect(decodeEncodedWords(`${word("abc")} \r\n\t${word("def")}`)).toBe("abcdef");
	});

	// Without the whitespace that makes it a fold, a break is not folding at all
	// and the value stays as it arrived rather than being quietly repaired.
	test("leaves a bare line break alone", () => {
		expect(decodeEncodedWords(`${word("abc")}\r\n${word("def")}`)).toMatch(/[\r\n]/);
	});

	test("keeps whitespace that belongs to the value", () => {
		expect(decodeEncodedWords(`${word("山田")} <y@example.jp>`)).toBe("山田 <y@example.jp>");
		expect(decodeEncodedWords(`${word("a")} plain ${word("b")}`)).toBe("a plain b");
	});

	test("round-trips what encodeHeader produces", () => {
		const subject = "第三四半期の売上報告書について、確認をお願いいたします";
		const raw = buildRfc822({ to: "a@example.com", subject, body: "b" });
		const header = (raw.split("\r\n\r\n")[0] ?? "")
			.split(/\r\n(?![ \t])/)
			.find((l) => l.startsWith("Subject:"));
		expect(decodeEncodedWords((header ?? "").slice("Subject: ".length))).toBe(subject);
	});
});
