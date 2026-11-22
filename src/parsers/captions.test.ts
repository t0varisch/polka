import { describe, expect, it } from "vitest";
import type { BookImage } from "../types";
import { allTextWrapped, applyCaptions, looksLikeCaption } from "./captions";

describe("looksLikeCaption", () => {
	it("слово подписи в начале: «Рис. 1», «Таблица 2», «Figure 3»", () => {
		for (const t of ["Рис. 1", "Рис.2. Схема сна", "Рисунок 3 — Подушка", "Табл. 4", "Figure 5. Sleep", "Схема", "Фото"]) {
			expect(looksLikeCaption(t, false), t).toBe(true);
		}
	});
	it("слово подписи — только целое слово", () => {
		expect(looksLikeCaption("Рисовать мы будем завтра, а сегодня отдыхаем.", false)).toBe(false);
		expect(looksLikeCaption("Картинка сразу видна, потому что мы привыкли замечать такие вещи в тексте.", false)).toBe(false);
	});
	it("короткая строка без конечной пунктуации", () => {
		expect(looksLikeCaption("Пример ортопедической подушки", false)).toBe(true);
	});
	it("короткая строка с концом предложения — не подпись", () => {
		expect(looksLikeCaption("Оцените степень удовлетворённости своим сном.", false)).toBe(false);
		for (const end of ["!", "?", "…", ":", ";", ","]) expect(looksLikeCaption("Короткая строка" + end, false), end).toBe(false);
	});
	it("строка длиннее 80 знаков без разметки — не подпись", () => {
		expect(looksLikeCaption("а".repeat(81), false)).toBe(false);
		expect(looksLikeCaption("а".repeat(80), false)).toBe(true);
	});
	it("маркер списка — не подпись", () => {
		for (const t of ["• начнёте", "- начнёте", "– начнёте", "— начнёте", "* начнёте", "1. Крестоносцы", "2) Второе"]) {
			expect(looksLikeCaption(t, false), t).toBe(false);
		}
	});
	it("размечено в книге: подпись любой длины до 300 знаков", () => {
		const t = "Длинная подпись к рисунку, которая заканчивается точкой. ".repeat(3).trim();
		expect(t.length).toBeGreaterThan(80);
		expect(looksLikeCaption(t, true)).toBe(true);
		expect(looksLikeCaption(t, false)).toBe(false);
	});
	it("длиннее 300 знаков — не подпись даже с разметкой", () => {
		expect(looksLikeCaption("а".repeat(300), true)).toBe(true);
		expect(looksLikeCaption("а".repeat(301), true)).toBe(false);
		expect(looksLikeCaption("Рис. " + "а".repeat(300), false)).toBe(false);
	});
	it("пустая строка — не подпись", () => {
		expect(looksLikeCaption("", true)).toBe(false);
		expect(looksLikeCaption("   ", false)).toBe(false);
	});
});

function im(at: number): BookImage {
	return { at, mime: "image/png", data: new Uint8Array([1]), w: 1, h: 1 };
}

describe("applyCaptions", () => {
	const paras = ["Рис. 1", "Текст.", "Пример подушки", "Рис. 2"];
	it("ставит caption только блочному рисунку", () => {
		const images = [im(3), im(2)];
		applyCaptions(images, [true, false], paras, new Set(), new Set());
		expect(images[0].caption).toBe(true);
		expect("caption" in images[1]).toBe(false);
	});
	it("из нескольких рисунков с одним at — только последний", () => {
		const images = [im(3), im(3)];
		applyCaptions(images, [true, true], paras, new Set(), new Set());
		expect("caption" in images[0]).toBe(false);
		expect(images[1].caption).toBe(true);
	});
	it("at за концом текста и заголовки — не подпись", () => {
		const images = [im(4), im(2)];
		applyCaptions(images, [true, true], paras, new Set(), new Set([2]));
		expect("caption" in images[0]).toBe(false);
		expect("caption" in images[1]).toBe(false);
	});
	it("рисунок в начале книги (at 0) подписи не получает", () => {
		const images = [im(0)];
		applyCaptions(images, [true], paras, new Set([0]), new Set());
		expect("caption" in images[0]).toBe(false);
	});
	it("размеченный абзац считается подписью", () => {
		const images = [im(1)];
		applyCaptions(images, [true], paras, new Set([1]), new Set());
		expect(images[0].caption).toBe(true);
	});
});

describe("allTextWrapped", () => {
	const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body.firstElementChild as Element;
	const tag = (e: Element) => e.localName;
	const W = new Set(["em", "i", "strong", "b"]);
	it("весь текст внутри em/strong", () => {
		expect(allTextWrapped(parse("<p> <em>Подпись</em> </p>"), tag, W)).toBe(true);
		expect(allTextWrapped(parse("<p><em><strong>Подпись</strong></em></p>"), tag, W)).toBe(true);
	});
	it("есть текст снаружи или нет текста", () => {
		expect(allTextWrapped(parse("<p>Как <em>курсив</em></p>"), tag, W)).toBe(false);
		expect(allTextWrapped(parse("<p>Просто</p>"), tag, W)).toBe(false);
		expect(allTextWrapped(parse("<p><em> </em></p>"), tag, W)).toBe(false);
	});
});
