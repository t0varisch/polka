import { describe, expect, it } from "vitest";
import { TEXT_VERSION, staleText } from "./text";

describe("staleText", () => {
	it("v1 у fb2 и epub — устарел", () => {
		expect(staleText({ v: 1 }, "fb2")).toBe(true);
		expect(staleText({ v: 1 }, "epub")).toBe(true);
	});

	it("v1 у txt, pdf и вставленного текста — не устарел", () => {
		for (const f of ["txt", "pdf", "text"] as const) expect(staleText({ v: 1 }, f)).toBe(false);
	});

	it("текущая версия — не устарел", () => {
		expect(staleText({ v: TEXT_VERSION }, "fb2")).toBe(false);
		expect(staleText({ v: TEXT_VERSION }, "epub")).toBe(false);
	});
});
