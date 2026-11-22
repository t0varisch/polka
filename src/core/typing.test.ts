import { describe, expect, it } from "vitest";
import { buildTypingText, isRequired, layoutHint, matches, nextRequired, normalizeParagraph, normalizeWithMap, TypingStats } from "./typing";

const ALL = { caseSensitive: true, punctuation: true };

describe("подготовка текста", () => {
	it("типографика → клавиатура", () => {
		expect(normalizeParagraph("«Привет», — сказал он…")).toBe('"Привет", - сказал он...');
		expect(normalizeParagraph("10 000  руб.")).toBe("10 000 руб.");
	});

	it("абзацы через перевод строки, начала абзацев", () => {
		const t = buildTypingText(["Раз два.", "  ", "Три"]);
		expect(t.text).toBe("Раз два.\nТри");
		expect(t.paraStarts).toEqual([0, 9, 9]);
	});
});

describe("что печатать", () => {
	it("непечатаемое пропускается, сдвоенный пробел после пропуска — тоже", () => {
		const text = "a © b";
		expect(isRequired(text, 0, ALL)).toBe(true);
		expect(isRequired(text, 1, ALL)).toBe(true);
		expect(isRequired(text, 2, ALL)).toBe(false);
		expect(isRequired(text, 3, ALL)).toBe(false);
		expect(nextRequired(text, 2, ALL)).toBe(4);
	});

	it("без знаков препинания", () => {
		const opts = { caseSensitive: true, punctuation: false };
		const text = "Да, нет";
		expect(isRequired(text, 2, opts)).toBe(false);
		expect(isRequired(text, 3, opts)).toBe(true);
	});
});

describe("проверка нажатия", () => {
	it("пробел — пробелом или Enter, абзац — так же", () => {
		expect(matches(" ", "\n", ALL)).toBe(true);
		expect(matches("\n", " ", ALL)).toBe(true);
	});
	it("ё и е, регистр", () => {
		expect(matches("ё", "е", ALL)).toBe(true);
		expect(matches("А", "а", ALL)).toBe(false);
		expect(matches("А", "а", { caseSensitive: false, punctuation: true })).toBe(true);
	});
	it("кавычки и тире из типографской раскладки", () => {
		expect(matches('"', "«", ALL)).toBe(true);
		expect(matches("-", "—", ALL)).toBe(true);
	});
	it("подсказка про раскладку", () => {
		expect(layoutHint("р", "h")).toMatch(/русскую/);
		expect(layoutHint("р", "п")).toBeNull();
	});
});

describe("скорость", () => {
	it("паузы дольше 3 с не считаются", () => {
		const s = new TypingStats();
		let t = 1000;
		for (let i = 0; i < 31; i++) s.hit(true, (t += 200)); // 30 интервалов по 200 мс = 6 с
		s.hit(true, (t += 60000)); // отошёл на минуту
		expect(s.activeMs).toBe(6000);
		expect(s.cpm).toBe(320); // 32 знака за 6 с
		s.hit(false, (t += 200));
		expect(s.accuracy).toBeCloseTo(97);
	});
});

describe("ошибки", () => {
	it("промахи подряд на одной букве — одна ошибка", () => {
		const s = new TypingStats();
		// нужна «б»: «в», «в», «в», потом «б»
		s.hit(false, 1000, 5);
		s.hit(false, 1100, 5);
		s.hit(false, 1200, 5);
		s.hit(true, 1300, 5);
		expect(s.errors).toBe(1);
		expect(s.correct).toBe(1);
	});

	it("промах на следующей букве — новая ошибка", () => {
		const s = new TypingStats();
		s.hit(false, 1000, 5);
		s.hit(true, 1100, 5);
		s.hit(false, 1200, 6);
		s.hit(false, 1300, 6);
		s.hit(true, 1400, 6);
		expect(s.errors).toBe(2);
	});

	it("после перехода в другое место промах на той же букве снова считается", () => {
		const s = new TypingStats();
		s.hit(false, 1000, 5);
		s.forgetMiss();
		s.hit(false, 1100, 5);
		expect(s.errors).toBe(2);
	});

	it("повторные промахи считаются временем печати", () => {
		const s = new TypingStats();
		s.hit(false, 1000, 5);
		s.hit(false, 1500, 5);
		s.hit(true, 2000, 5);
		expect(s.activeMs).toBe(1000);
	});

	it("без номера буквы каждый промах — ошибка, как раньше", () => {
		const s = new TypingStats();
		s.hit(false, 1000);
		s.hit(false, 1100);
		expect(s.errors).toBe(2);
	});
});

describe("скорость нормализации", () => {
	it("миллион символов — быстрее 1500 мс", () => {
		const para = "«Привет», — сказал он… тут и  там ".repeat(3).slice(0, 100).padEnd(100, "я");
		const paras = Array.from({ length: 10000 }, () => para);
		const t0 = performance.now();
		const tt = buildTypingText(paras);
		for (const p of paras) normalizeWithMap(p);
		const ms = performance.now() - t0;
		expect(tt.text.length).toBeGreaterThan(900000);
		expect(ms).toBeLessThan(1500);
	});
});
