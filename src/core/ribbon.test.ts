import { describe, expect, it } from "vitest";
import { nextLineTop, nextScreenTop, prevLineTop, prevScreenTop, chainStart, locateCell, screenGrid, screenIndex } from "./ribbon";

/** Строки по 30 px: верх 0, 30, 60…; низ 30, 60, 90… */
const lines = (n: number) => ({
	tops: Array.from({ length: n }, (_, i) => i * 30),
	bottoms: Array.from({ length: n }, (_, i) => i * 30 + 30),
});

describe("nextScreenTop", () => {
	it("экран начинается со строки, которая не влезла целиком", () => {
		const { tops, bottoms } = lines(20);
		expect(nextScreenTop(tops, bottoms, 0, 100)).toBe(90);
		expect(nextScreenTop(tops, bottoms, 90, 100)).toBe(180);
	});

	it("строка, влезшая ровно по нижнему краю, не переносится", () => {
		const { tops, bottoms } = lines(20);
		expect(nextScreenTop(tops, bottoms, 0, 90)).toBe(90);
	});

	it("рисунок, обрезанный внизу, открывает следующий экран", () => {
		// строки до 100, рисунок 100-400, дальше строки
		const tops = [0, 30, 60, 100, 400, 430];
		const bottoms = [30, 60, 90, 400, 430, 460];
		expect(nextScreenTop(tops, bottoms, 0, 200)).toBe(100);
	});

	it("конец текста: прокручивать некуда, возвращается top", () => {
		const { tops, bottoms } = lines(4);
		expect(nextScreenTop(tops, bottoms, 0, 120)).toBe(0);
		expect(nextScreenTop(tops, bottoms, 0, 500)).toBe(0);
		expect(nextScreenTop([], [], 40, 100)).toBe(40);
	});

	it("элемент выше экрана, начавшийся выше top: берётся верх следующего", () => {
		// рисунок 0-500 выше экрана 200; экран уже стоит внутри него
		const tops = [0, 500, 530];
		const bottoms = [500, 530, 560];
		expect(nextScreenTop(tops, bottoms, 0, 200)).toBe(500);
		expect(nextScreenTop(tops, bottoms, 100, 200)).toBe(500);
	});

	it("элемент выше экрана и дальше ничего нет: top + height", () => {
		expect(nextScreenTop([0], [500], 0, 200)).toBe(200);
	});
});

describe("prevScreenTop", () => {
	it("прежний экран: наименьший верх строки не меньше top - height", () => {
		const { tops } = lines(20);
		expect(prevScreenTop(tops, 90, 100)).toBe(0);
		expect(prevScreenTop(tops, 180, 100)).toBe(90);
	});

	it("у начала — 0, меньше нуля не бывает", () => {
		const { tops } = lines(20);
		expect(prevScreenTop(tops, 0, 100)).toBe(0);
		expect(prevScreenTop(tops, 40, 100)).toBe(0);
		expect(prevScreenTop([], 10, 100)).toBe(0);
	});

	it("в окне нет ни одной строки: сдвиг на высоту экрана", () => {
		// рисунок 100-900 выше экрана, строк с верхом в [top - height, top) нет
		expect(prevScreenTop([0, 100, 900], 700, 200)).toBe(500);
	});
});

describe("nextLineTop / prevLineTop", () => {
	const { tops } = lines(10);

	it("вперёд: наименьший верх строки больше top + 2", () => {
		expect(nextLineTop(tops, 0)).toBe(30);
		expect(nextLineTop(tops, 30)).toBe(60);
		// верх чуть выше строки (дробные размеры) — всё равно следующая строка
		expect(nextLineTop(tops, 29.5)).toBe(60);
		expect(nextLineTop(tops, 12)).toBe(30);
	});

	it("строка в 1–2 px ниже верха окна уже стоит сверху (WebKit, целые пиксели)", () => {
		expect(nextLineTop(tops, 28.2)).toBe(60);
		expect(nextLineTop(tops, 58.744)).toBe(90);
	});

	it("вперёд: следующей строки нет — top", () => {
		expect(nextLineTop(tops, 270)).toBe(270);
		expect(nextLineTop([], 5)).toBe(5);
	});

	it("назад: наибольший верх строки меньше top - 2", () => {
		expect(prevLineTop(tops, 90)).toBe(60);
		expect(prevLineTop(tops, 60.5)).toBe(30);
		expect(prevLineTop(tops, 70)).toBe(60);
	});

	it("строка в 1–2 px выше верха окна — та, что сверху, вверх едет на предыдущую", () => {
		expect(prevLineTop(tops, 61.8)).toBe(30);
	});

	it("назад: строк выше нет — 0", () => {
		expect(prevLineTop(tops, 0)).toBe(0);
		expect(prevLineTop(tops, 1)).toBe(0);
		expect(prevLineTop([], 50)).toBe(0);
	});

	it("рисунок между строками считается строкой", () => {
		const t = [0, 30, 60, 100, 400];
		expect(nextLineTop(t, 60)).toBe(100);
		expect(prevLineTop(t, 400)).toBe(100);
	});
});

describe("screenGrid", () => {
	it("верхи экранов: от нуля, каждый — nextScreenTop от прежнего", () => {
		const { tops, bottoms } = lines(20);
		expect(screenGrid(tops, bottoms, 100)).toEqual([0, 90, 180, 270, 360, 450, 540]);
	});

	it("нет строк — один экран", () => {
		expect(screenGrid([], [], 100)).toEqual([0]);
	});

	it("текст короче экрана — один экран", () => {
		const { tops, bottoms } = lines(3);
		expect(screenGrid(tops, bottoms, 100)).toEqual([0]);
	});

	it("высокий рисунок: рисунок выше экрана — свой экран, остаток пропущен", () => {
		// строка 0-30, рисунок 30-330, строка 330-360
		expect(screenGrid([0, 30, 330], [30, 330, 360], 100)).toEqual([0, 30, 330]);
	});
});

describe("screenIndex", () => {
	const grid = [0, 90, 180];
	it("номер ячейки, в которую попало смещение", () => {
		expect(screenIndex(grid, 0)).toBe(0);
		expect(screenIndex(grid, 89)).toBe(0);
		expect(screenIndex(grid, 90)).toBe(1);
		expect(screenIndex(grid, 179)).toBe(1);
		expect(screenIndex(grid, 500)).toBe(2);
	});

	it("смещение выше куска — первая ячейка", () => {
		expect(screenIndex(grid, -40)).toBe(0);
	});

	it("прыжок со строки (верха строки или экрана) попадает в следующую ячейку", () => {
		const { tops, bottoms } = lines(20);
		const g = screenGrid(tops, bottoms, 100);
		for (let off = 0; off < 510; off += 30) {
			const to = nextScreenTop(tops, bottoms, off, 100);
			expect(screenIndex(g, to)).toBe(screenIndex(g, off) + 1);
		}
	});
});

describe("screenGrid со сдвигом начала", () => {
	it("сетка идёт от заданного начала", () => {
		const { tops, bottoms } = lines(20);
		expect(screenGrid(tops, bottoms, 100, 30)).toEqual([30, 120, 210, 300, 390, 480, 570]);
	});
});

describe("chainStart", () => {
	// следующий кусок: строки по 30 px от его верха; последняя ячейка предыдущего начиналась на 40 px выше его верха
	it("начало сетки — куда ляжет экран после последней ячейки предыдущего куска", () => {
		const { tops, bottoms } = lines(20);
		// край экрана: -40 + 100 = 60 от верха куска; первая строка с низом ниже 60 — третья (верх 60)
		expect(chainStart(tops, bottoms, -40, 100)).toBe(60);
	});

	it("кусок целиком влезает в последний экран предыдущего — null (0 страниц)", () => {
		const { tops, bottoms } = lines(2);
		expect(chainStart(tops, bottoms, -40, 100)).toBeNull();
	});

	it("цепочка через кусок из 0 страниц: тот же край продолжается дальше", () => {
		// A: последняя ячейка на -40 от верха B; B из двух строк (60 px) целиком в ней; C стоит на 60 px ниже верха B
		const b = lines(2);
		expect(chainStart(b.tops, b.bottoms, -40, 100)).toBeNull();
		const c = lines(10);
		expect(chainStart(c.tops, c.bottoms, -40 - 60, 100)).toBe(0);
	});
});

describe("locateCell", () => {
	it("последняя ячейка, чей верх не ниже прокрутки", () => {
		const grids = [[0, 90, 180], [250, 340]];
		expect(locateCell(grids, 0)).toEqual({ chunk: 0, cell: 0 });
		expect(locateCell(grids, 200)).toEqual({ chunk: 0, cell: 2 });
		expect(locateCell(grids, 250)).toEqual({ chunk: 1, cell: 0 });
		expect(locateCell(grids, 900)).toEqual({ chunk: 1, cell: 1 });
	});

	it("прокрутка выше начала сетки куска B — последняя ячейка куска A", () => {
		const grids = [[0, 90, 180], [250, 340]];
		expect(locateCell(grids, 220)).toEqual({ chunk: 0, cell: 2 });
	});

	it("допуск на округление: целый scrollTop на пиксель ниже верха ячейки — уже в ней", () => {
		const grids = [[0, 90.79, 180.4]];
		expect(locateCell(grids, 90)).toEqual({ chunk: 0, cell: 0 });
		expect(locateCell(grids, 90, 1)).toEqual({ chunk: 0, cell: 1 });
	});

	it("кусок без страниц пропускается", () => {
		const grids = [[0, 90], [], [200]];
		expect(locateCell(grids, 150)).toEqual({ chunk: 0, cell: 1 });
		expect(locateCell(grids, 210)).toEqual({ chunk: 2, cell: 0 });
	});

	it("выше самой первой ячейки — первая ячейка; ячеек нет совсем — null", () => {
		expect(locateCell([[40, 130]], 0)).toEqual({ chunk: 0, cell: 0 });
		expect(locateCell([[], []], 10)).toBeNull();
	});
});
