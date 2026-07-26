import { describe, expect, test } from "bun:test";
import {
	b64urlDecode,
	b64urlEncode,
	buildRfc822,
	decodeAttachmentText,
	extractBody,
	headerValue,
	summarizeMessage,
	textPartAttachment,
	truncate,
} from "../src/gmail";

describe("b64url", () => {
	test("round-trips ASCII", () => {
		expect(b64urlDecode(b64urlEncode("hello world"))).toBe("hello world");
	});

	test("round-trips UTF-8", () => {
		const s = "件名テスト aynu itak 🐟";
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
		const body = "アイヌ語 corpus line\n".repeat(20_000);
		const raw = buildRfc822({ to: "a@example.com", subject: "big", body });
		const encoded = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
		expect(b64urlDecode(encoded.replace(/\+/g, "-").replace(/\//g, "_"))).toBe(body);
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
