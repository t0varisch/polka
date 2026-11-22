import { describe, expect, it } from "vitest";
import { chapterTicks, type ChapterMark } from "./nav";

const mk = (word: number, level = 0): ChapterMark => ({ title: `Глава ${word}`, level, word });

describe("chapterTicks", () => {
	it("главы одного уровня — проценты от total - 1, без нуля", () => {
		const t = chapterTicks([mk(0), mk(500), mk(900)], 1000);
		expect(t).toHaveLength(2);
		expect(t[0]).toBeCloseTo(50.05, 2);
		expect(t[1]).toBeCloseTo(90.09, 2);
	});
	it("при уровнях 0 и 1 берётся только уровень 0", () => {
		const t = chapterTicks([mk(0), mk(200, 1), mk(500), mk(700, 1), mk(900)], 1000);
		expect(t).toHaveLength(2);
		expect(t[0]).toBeCloseTo(50.05, 2);
		expect(t[1]).toBeCloseTo(90.09, 2);
	});
	it("если верхнего уровня меньше двух — все уровни", () => {
		const t = chapterTicks([mk(0), mk(100, 1), mk(200, 1), mk(300, 1), mk(400, 1), mk(500, 1)], 1000);
		expect(t).toHaveLength(5);
	});
	it("порядок возрастает, даже если главы поданы вразнобой", () => {
		const t = chapterTicks([mk(900), mk(300), mk(600)], 1000);
		expect(t).toEqual([...t].sort((a, b) => a - b));
		expect(t).toHaveLength(3);
	});
	it("400 глав — не больше 150 засечек, по возрастанию", () => {
		const chapters = Array.from({ length: 400 }, (_, i) => mk(i * 100 + 50));
		const t = chapterTicks(chapters, 40100);
		expect(t).toHaveLength(150);
		expect(t).toEqual([...t].sort((a, b) => a - b));
		// прореживание равномерное: засечки разбросаны по всей книге
		expect(t[0]).toBeLessThan(2);
		expect(t[149]).toBeGreaterThan(98);
	});
	it("свой max", () => {
		const chapters = Array.from({ length: 40 }, (_, i) => mk(i * 100 + 50));
		expect(chapterTicks(chapters, 4100, 10)).toHaveLength(10);
	});
	it("главы на соседних словах дают одну засечку", () => {
		const t = chapterTicks([mk(0), mk(500), mk(501)], 1000);
		expect(t).toHaveLength(1);
	});
	it("пусто и крошечная книга не ломают", () => {
		expect(chapterTicks([], 1000)).toEqual([]);
		expect(chapterTicks([mk(0), mk(0)], 1)).toEqual([]);
	});
});
