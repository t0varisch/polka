import { describe, expect, it } from "vitest";
import { cleanQuote } from "./quote";

describe("cleanQuote", () => {
	it("переводы строк и двойные пробелы — один пробел, края обрезаны", () => {
		expect(cleanQuote("  раз\n\nдва   три\t\nчетыре \n")).toBe("раз два три четыре");
	});
	it("пустая и пробельная строка — пустая", () => {
		expect(cleanQuote("")).toBe("");
		expect(cleanQuote(" \n\t ")).toBe("");
	});
	it("короткий текст не трогается", () => {
		expect(cleanQuote("слово ".repeat(10), 1000)).toBe("слово ".repeat(10).trim());
	});
	it("длиннее max — обрезка по границе слова и «…»", () => {
		const out = cleanQuote("слово ".repeat(400));
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(1001);
		expect(out.slice(0, -1).split(" ").every((w) => w === "слово")).toBe(true);
	});
	it("max задаётся параметром", () => {
		expect(cleanQuote("один два три четыре", 10)).toBe("один два…");
	});
	it("одно длинное слово без пробелов режется по max", () => {
		expect(cleanQuote("а".repeat(50), 10)).toBe("а".repeat(10) + "…");
	});
});
