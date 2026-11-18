import { describe, expect, it } from "vitest";
import type { BookRecord, ParsedBook } from "../types";
import { bookId } from "./hash";
import { mergeProgress, newRecord, parseProgress } from "./record";

function rec(id: string, updatedAt: number, title = id): BookRecord {
	return {
		id,
		title,
		author: "",
		format: "txt",
		wordCount: 10,
		position: { word: 0, para: 0, snippet: "", mode: "pages", at: updatedAt },
		bookmarks: [],
		typing: { correct: 0, errors: 0, activeMs: 0 },
		addedAt: 1,
		openedAt: 1,
		updatedAt,
	};
}

describe("mergeProgress", () => {
	const disk = { version: 1 as const, books: { A: rec("A", 100, "диск"), B: rec("B", 100) } };

	it("новая A заменяет дисковую, B на месте", () => {
		const out = mergeProgress(disk, rec("A", 200, "новая"));
		expect(out.books.A.title).toBe("новая");
		expect(out.books.B).toBe(disk.books.B);
	});

	it("старая A не затирает дисковую", () => {
		const out = mergeProgress(disk, rec("A", 50, "старая"));
		expect(out.books.A.title).toBe("диск");
		expect(out.books.B).toBeDefined();
	});

	it("null на диске — файл с одной книгой", () => {
		const out = mergeProgress(null, rec("A", 1));
		expect(out.version).toBe(1);
		expect(Object.keys(out.books)).toEqual(["A"]);
	});
});

describe("parseProgress", () => {
	it("мусор — пустой файл", () => {
		expect(parseProgress("мусор")).toEqual({ version: 1, books: {} });
		expect(parseProgress('{"version":2,"books":{}}')).toEqual({ version: 1, books: {} });
		expect(parseProgress("null")).toEqual({ version: 1, books: {} });
	});
	it("верный файл читается", () => {
		const f = { version: 1, books: { A: rec("A", 1) } };
		expect(parseProgress(JSON.stringify(f))).toEqual(f);
	});
});

describe("newRecord", () => {
	it("позиция в начале, режим pages", () => {
		const book: ParsedBook = {
			title: "Т",
			author: "А",
			format: "txt",
			paragraphs: ["раз два три четыре пять шесть семь восемь девять десять"],
			toc: [],
		};
		const r = newRecord("id1", book, 10, 555);
		expect(r.position).toEqual({ word: 0, para: 0, snippet: "раз два три четыре пять шесть семь восемь", mode: "pages", at: 555 });
		expect(r.addedAt).toBe(555);
		expect(r.openedAt).toBe(555);
		expect(r.updatedAt).toBe(555);
		expect(r.bookmarks).toEqual([]);
		expect(r.typing).toEqual({ correct: 0, errors: 0, activeMs: 0 });
	});
});

describe("bookId", () => {
	it("одинаковые байты — одинаковый id из 32 символов", async () => {
		const a = await bookId(new Uint8Array([1, 2, 3]));
		const b = await bookId(new Uint8Array([1, 2, 3]));
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
	});
	it("разные байты — разный id", async () => {
		expect(await bookId(new Uint8Array([1]))).not.toBe(await bookId(new Uint8Array([2])));
	});
});
