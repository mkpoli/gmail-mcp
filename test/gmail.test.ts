import { describe, expect, test } from "bun:test";
import {
	b64urlDecode,
	b64urlEncode,
	buildRfc822,
	decodeAttachmentText,
	escapeHtml,
	extractBody,
	forwardHeaderBlock,
	forwardHtmlBlock,
	forwardSubject,
	headerValue,
	parseAddresses,
	quoteHtml,
	quotePlain,
	replySubject,
	summarizeMessage,
	textPartAttachment,
	truncate,
} from "../src/gmail";

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
		const body = lines[lines.length - 1];
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
		const encoded = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
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
		expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
		expect(atob(parts[1].trim().split("\r\n").pop() ?? "")).toBe("plain version");
		expect(parts[2]).toContain('Content-Type: text/html; charset="UTF-8"');
		expect(atob(parts[2].trim().split("\r\n").pop() ?? "")).toBe("<h1>rich version</h1>");
		expect(parts[3].trim()).toBe("--");
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

	test("keeps bare addresses untouched", () => {
		const raw = buildRfc822({ to: "a@example.com, b@example.org", subject: "s", body: "b" });
		expect(raw).toContain("To: a@example.com, b@example.org");
	});

	test("folds long encoded subjects into 75-octet words", () => {
		const raw = buildRfc822({ to: "a@example.com", subject: "日本語".repeat(40), body: "b" });
		const lines = raw.split("\r\n");
		const start = lines.findIndex((l) => l.startsWith("Subject:"));
		const words = [lines[start], ...lines.slice(start + 1).filter((l) => l.startsWith(" "))]
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
		const bodyLines = raw.split("\r\n\r\n")[1].split("\r\n");
		expect(bodyLines.length).toBeGreaterThan(1);
		for (const line of bodyLines) {
			expect(line.length).toBeLessThanOrEqual(76);
		}
	});
});

describe("extractBody", () => {
	const part = (mimeType: string, text: string, parts?: any[]) => ({
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
					body: { attachmentId: "body-att" },
				},
			],
		};
		expect(textPartAttachment(payload)).toEqual({
			attachmentId: "body-att",
			mimeType: "text/plain",
			charset: "utf-8",
		});
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
			date: "Fri, 25 Jul 2026 10:00:00 +0900",
			subject: "case test",
		});
	});
});
