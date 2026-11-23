import { describe, expect, it } from "vitest";
import { estimateChunkPages, PageNumbers, paraLines } from "./pagecount";

describe("paraLines", () => {
	it("пустой абзац — 0 строк", () => {
		expect(paraLines(0, 40)).toBe(0);
	});
	it("отступ входит в длину", () => {
		expect(paraLines(38, 40)).toBe(1);
		expect(paraLines(39, 40)).toBe(2);
	});
});

describe("estimateChunkPages", () => {
	const g = { charsPerLine: 40, linesPerPage: 5 };
	it("три абзаца по 100 знаков — 9 строк, 2 страницы", () => {
		const p = { chars: 100, heading: false };
		expect(estimateChunkPages([p, p, p], 0, g)).toBe(2);
	});
	it("заголовок крупнее: 40 знаков — 2 строки", () => {
		// 2 строки заголовка + 4 строки абзаца (100 + 2 знаков → 3, 3 строки) -> проверяем через границу страницы
		expect(estimateChunkPages([{ chars: 40, heading: true }, { chars: 120, heading: false }], 0, g)).toBe(2);
		expect(estimateChunkPages([{ chars: 40, heading: true }, { chars: 80, heading: false }], 0, g)).toBe(1);
	});
	it("добавочные строки считаются", () => {
		expect(estimateChunkPages([{ chars: 100, heading: false }], 5, g)).toBe(2);
	});
	it("пустой кусок — одна страница", () => {
		expect(estimateChunkPages([], 0, g)).toBe(1);
	});
});

describe("PageNumbers", () => {
	it("оценки и точные числа", () => {
		const n = new PageNumbers([3, 4, 5]);
		expect(n.startOf(0)).toBe(0);
		expect(n.startOf(2)).toBe(7);
		expect(n.total).toBe(12);
		n.setMeasured(1, 6);
		expect(n.startOf(2)).toBe(9);
		expect(n.total).toBe(14);
	});
});

describe("PageNumbers: кусок без страниц", () => {
	it("0 страниц допустимы и не сдвигают номера", () => {
		const p = new PageNumbers([3, 3, 3]);
		p.setMeasured(1, 0);
		expect(p.startOf(2)).toBe(3);
		expect(p.total).toBe(6);
	});
});
