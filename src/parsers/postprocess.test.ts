import { describe, expect, it } from "vitest";
import type { BookImage, ParsedBook } from "../types";
import { dropPrintedToc } from "./postprocess";

const LONG = "Длинный абзац настоящего текста книги, который точно не похож на строку оглавления и длиннее ста знаков, чтобы разбор остановился.";

function img(at: number, tag: number): BookImage {
	return { at, mime: "image/png", data: new Uint8Array([tag]), w: 1, h: 1 };
}

function book(images?: BookImage[]): ParsedBook {
	return {
		title: "Т",
		author: "",
		format: "fb2",
		paragraphs: ["Начало книги", "Ещё абзац", "Содержание", "Глава первая 3", "Глава вторая 10", "Глава третья 20", LONG, LONG + " Второй."],
		toc: [{ title: "Начало книги", level: 0, paragraph: 0 }],
		images,
	};
}

describe("dropPrintedToc: рисунки", () => {
	it("at пересчитывается на число выброшенных абзацев левее", () => {
		// выбрасываются абзацы 2–5; рисунки до, на границе, внутри, сразу после и в конце
		const out = dropPrintedToc(book([img(0, 1), img(2, 2), img(4, 3), img(6, 4), img(8, 5)]));
		expect(out.paragraphs).toEqual(["Начало книги", "Ещё абзац", LONG, LONG + " Второй."]);
		expect(out.images!.map((i) => i.at)).toEqual([0, 2, 2, 2, 4]);
		expect(out.images!.map((i) => i.data[0])).toEqual([1, 2, 3, 4, 5]);
		for (const i of out.images!) expect(i.at).toBeLessThanOrEqual(out.paragraphs.length);
	});

	it("без выброшенных абзацев images возвращается как есть", () => {
		const plain: ParsedBook = { ...book([img(1, 1)]), paragraphs: ["Раз", "Два"] };
		const out = dropPrintedToc(plain);
		expect(out).toBe(plain);
		expect(out.images).toBe(plain.images);
	});

	it("книга без рисунков остаётся без images", () => {
		expect(dropPrintedToc(book()).images).toBeUndefined();
	});
});
