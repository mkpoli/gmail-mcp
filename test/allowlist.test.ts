import { describe, expect, test } from "bun:test";
import { isEmailAllowed, isUnderAccountCap, parseLimit } from "../src/utils";

describe("isEmailAllowed", () => {
	test("admits no one when unset or empty", () => {
		expect(isEmailAllowed("a@example.com", undefined)).toBe(false);
		expect(isEmailAllowed("a@example.com", "")).toBe(false);
		expect(isEmailAllowed("a@example.com", "  , ,  ")).toBe(false);
	});

	test("matches exact addresses case-insensitively", () => {
		expect(isEmailAllowed("A@Example.com", "a@example.com")).toBe(true);
		expect(isEmailAllowed("a@example.com", "b@example.com, a@example.com")).toBe(true);
		expect(isEmailAllowed("c@example.com", "a@example.com,b@example.com")).toBe(false);
	});

	test("matches a domain pattern only within that domain", () => {
		expect(isEmailAllowed("anyone@example.com", "*@example.com")).toBe(true);
		expect(isEmailAllowed("anyone@other.com", "*@example.com")).toBe(false);
		// A lookalike domain must not pass.
		expect(isEmailAllowed("attacker@notexample.com", "*@example.com")).toBe(false);
		expect(isEmailAllowed("attacker@example.com.evil.net", "*@example.com")).toBe(false);
	});

	test("wildcard admits any address", () => {
		expect(isEmailAllowed("anyone@anywhere.org", "*")).toBe(true);
		expect(isEmailAllowed("someone@gmail.com", "a@example.com, *")).toBe(true);
	});

	test("a bare domain without the star does not match its addresses", () => {
		expect(isEmailAllowed("a@example.com", "example.com")).toBe(false);
	});
});

describe("isUnderAccountCap", () => {
	test("lets a known account through whatever the count", () => {
		expect(isUnderAccountCap(999, false, 25)).toBe(true);
		expect(isUnderAccountCap(999, false, 0)).toBe(true);
	});

	test("admits a new account below the cap and refuses it at the cap", () => {
		expect(isUnderAccountCap(24, true, 25)).toBe(true);
		expect(isUnderAccountCap(25, true, 25)).toBe(false);
		expect(isUnderAccountCap(26, true, 25)).toBe(false);
	});

	test("a cap of zero or less admits nobody new", () => {
		expect(isUnderAccountCap(0, true, 0)).toBe(false);
		expect(isUnderAccountCap(0, true, -1)).toBe(false);
		expect(isUnderAccountCap(0, true, Number.NaN)).toBe(false);
	});

	// A KV listing stops at 1000 keys, so a caller that cannot count the accounts
	// says so with an unbounded count rather than reporting the truncated one.
	test("an uncountable number of accounts refuses a new one", () => {
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, true, 25)).toBe(false);
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, true, 5000)).toBe(false);
		expect(isUnderAccountCap(Number.POSITIVE_INFINITY, false, 25)).toBe(true);
	});
});

describe("parseLimit", () => {
	test("reads a positive integer", () => {
		expect(parseLimit("50", 25)).toBe(50);
	});

	test("falls back on anything unusable", () => {
		expect(parseLimit(undefined, 25)).toBe(25);
		expect(parseLimit("", 25)).toBe(25);
		expect(parseLimit("nope", 25)).toBe(25);
		expect(parseLimit("0", 25)).toBe(25);
		expect(parseLimit("-5", 25)).toBe(25);
	});
});
