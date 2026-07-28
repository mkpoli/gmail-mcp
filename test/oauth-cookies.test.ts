import { describe, expect, it } from "bun:test";
import { addApprovedClient, isClientApproved } from "../src/workers-oauth-utils";

const SECRET = "test-cookie-secret";

function withCookie(value: string): Request {
	return new Request("https://example.test/authorize", {
		headers: { Cookie: `__Host-APPROVED_CLIENTS=${value}` },
	});
}

function cookieValue(setCookie: string): string {
	return setCookie.slice("__Host-APPROVED_CLIENTS=".length).split(";")[0] ?? "";
}

describe("approved-client cookie", () => {
	it("remembers a client it signed", async () => {
		const setCookie = await addApprovedClient(
			new Request("https://example.test/authorize"),
			"client-a",
			SECRET,
		);
		expect(await isClientApproved(withCookie(cookieValue(setCookie)), "client-a", SECRET)).toBe(
			true,
		);
		expect(await isClientApproved(withCookie(cookieValue(setCookie)), "client-b", SECRET)).toBe(
			false,
		);
	});

	it("rejects a cookie signed with another secret", async () => {
		const setCookie = await addApprovedClient(
			new Request("https://example.test/authorize"),
			"client-a",
			SECRET,
		);
		expect(
			await isClientApproved(withCookie(cookieValue(setCookie)), "client-a", "other-secret"),
		).toBe(false);
	});

	// A corrupted cookie has to read as "not approved" rather than throw: the
	// /authorize handler calls this before any error boundary, so an exception
	// here answers 500 to a browser that can only recover by clearing cookies
	// by hand.
	it.each([
		["not base64", "deadbeef.@@@not-base64@@@"],
		["empty payload", "deadbeef."],
		["no separator", "deadbeef"],
		["extra separator", "dead.beef.cafe"],
		["empty", ""],
		["payload is not JSON", `deadbeef.${btoa("not json")}`],
		["payload is not an array", `deadbeef.${btoa('{"a":1}')}`],
		["signature is not hex", `zzzz.${btoa('["client-a"]')}`],
	])("returns false for a %s cookie", async (_name, value) => {
		expect(await isClientApproved(withCookie(value), "client-a", SECRET)).toBe(false);
	});

	it("returns false when no cookie is present", async () => {
		expect(
			await isClientApproved(new Request("https://example.test/authorize"), "client-a", SECRET),
		).toBe(false);
	});
});
