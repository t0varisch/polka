import { describe, expect, it } from "vitest";
import { nextLineTop, nextScreenTop, prevLineTop, prevScreenTop, resolveFlow } from "./ribbon";

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

describe("resolveFlow", () => {
	it("авто: лента на грубом указателе, иначе страницы", () => {
		expect(resolveFlow("auto", true)).toBe("ribbon");
		expect(resolveFlow("auto", false)).toBe("pages");
	});

	it("явное значение не меняется", () => {
		expect(resolveFlow("pages", true)).toBe("pages");
		expect(resolveFlow("ribbon", false)).toBe("ribbon");
	});
});

describe("nextLineTop / prevLineTop", () => {
	const { tops } = lines(10);

	it("вперёд: наименьший верх строки больше top + 1", () => {
		expect(nextLineTop(tops, 0)).toBe(30);
		expect(nextLineTop(tops, 30)).toBe(60);
		// верх чуть выше строки (дробные размеры) — всё равно следующая строка
		expect(nextLineTop(tops, 29.5)).toBe(60);
		expect(nextLineTop(tops, 12)).toBe(30);
	});

	it("вперёд: следующей строки нет — top", () => {
		expect(nextLineTop(tops, 270)).toBe(270);
		expect(nextLineTop([], 5)).toBe(5);
	});

	it("назад: наибольший верх строки меньше top - 1", () => {
		expect(prevLineTop(tops, 90)).toBe(60);
		expect(prevLineTop(tops, 60.5)).toBe(30);
		expect(prevLineTop(tops, 70)).toBe(60);
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
