import { describe, expect, it, vi } from "vitest";
import type { BookImage } from "../types";
import type { Chunk } from "./chunks";
import { fitSize, imagesByChunk, maxImageHeight, settledWithin } from "./figures";

const chunks: Chunk[] = [
	{ fromPara: 0, toPara: 10, fromWord: 0, toWord: 100 },
	{ fromPara: 10, toPara: 20, fromWord: 100, toWord: 200 },
	{ fromPara: 20, toPara: 30, fromWord: 200, toWord: 300 },
];
const img = (at: number, extra: Partial<BookImage> = {}): BookImage => ({ at, mime: "image/png", data: new Uint8Array(1), w: 10, h: 10, ...extra });

describe("imagesByChunk", () => {
	it("рисунок внутри куска идёт в него", () => {
		expect(imagesByChunk(chunks, [img(5), img(15), img(25)], 30)).toEqual([[0], [1], [2]]);
	});
	it("at = 0 — в первый кусок", () => {
		expect(imagesByChunk(chunks, [img(0)], 30)).toEqual([[0], [], []]);
	});
	it("at на границе кусков — в конец предыдущего", () => {
		expect(imagesByChunk(chunks, [img(10), img(20)], 30)).toEqual([[0], [1], []]);
	});
	it("at = paraCount и больше — в конец последнего", () => {
		expect(imagesByChunk(chunks, [img(30), img(99)], 30)).toEqual([[], [], [0, 1]]);
	});
	it("рисунок с подписью на границе — в кусок, где лежит абзац подписи", () => {
		expect(imagesByChunk(chunks, [img(10, { caption: true }), img(20, { caption: true })], 30)).toEqual([[], [0], [1]]);
	});
	it("порядок рисунков в куске сохраняется", () => {
		expect(imagesByChunk(chunks, [img(3), img(3), img(7)], 30)).toEqual([[0, 1, 2], [], []]);
	});
	it("без кусков — пусто", () => {
		expect(imagesByChunk([], [img(1)], 0)).toEqual([]);
	});
});

describe("maxImageHeight", () => {
	it("короткая подпись: рисунок целыми строками, вместе с подписью не выше колонки", () => {
		const m = maxImageHeight(600, 30, 60) as number;
		expect(m % 30).toBe(0);
		expect(m + 60).toBeLessThanOrEqual(600);
		expect(m).toBeGreaterThanOrEqual(480);
	});
	it("длинная подпись (5 строк): рисунок уменьшается до остатка колонки", () => {
		const m = maxImageHeight(600, 30, 150) as number;
		expect(m).toBe(420);
	});
	it("рисунок не меньше 3 строк", () => {
		expect(maxImageHeight(600, 30, 510)).toBe(90);
		expect(maxImageHeight(600, 30, 500)).toBe(90);
		expect(maxImageHeight(600, 30, 511)).toBe(null);
	});
	it("подпись выше (колонка − 3 строки) — null, фигура может разорваться", () => {
		expect(maxImageHeight(600, 30, 520)).toBe(null);
	});
});

describe("fitSize", () => {
	it("шире окна — по ширине, пропорции сохраняются", () => {
		expect(fitSize(1000, 500, 400, 800)).toEqual({ w: 400, h: 200 });
	});
	it("выше окна — по высоте", () => {
		expect(fitSize(500, 1000, 400, 300)).toEqual({ w: 150, h: 300 });
	});
	it("меньше окна — не увеличивается", () => {
		expect(fitSize(100, 50, 400, 300)).toEqual({ w: 100, h: 50 });
	});
	it("крайние пропорции — не меньше 1 пикселя", () => {
		expect(fitSize(10000, 2, 100, 100)).toEqual({ w: 100, h: 1 });
		expect(fitSize(2, 10000, 100, 100)).toEqual({ w: 1, h: 100 });
	});
	it("целые пиксели", () => {
		const r = fitSize(333, 777, 100, 100);
		expect(Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true);
	});
});

describe("settledWithin", () => {
	it("зависший промис: через срок false", async () => {
		vi.useFakeTimers();
		const r = settledWithin(new Promise(() => {}), 4000);
		await vi.advanceTimersByTimeAsync(4000);
		expect(await r).toBe(false);
		vi.useRealTimers();
	});
	it("завершился или отклонён вовремя: true", async () => {
		expect(await settledWithin(Promise.resolve(1), 4000)).toBe(true);
		expect(await settledWithin(Promise.reject(new Error("x")), 4000)).toBe(true);
	});
});
