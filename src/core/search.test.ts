import { describe, expect, it } from "vitest";
import { findInBook, normalizeForSearch } from "./search";
import { buildWords } from "./words";

const find = (paras: string[], q: string, limit?: number) => findInBook(paras, buildWords(paras), q, limit);

describe("normalizeForSearch", () => {
	it("регистр", () => expect(normalizeForSearch("ПрИвЕт Мир")).toBe("привет мир"));
	it("ё → е", () => expect(normalizeForSearch("Ёлка и ёж")).toBe("елка и еж"));
	it("все тире и дефисы → -", () => {
		expect(normalizeForSearch("a‐b‑c‒d–e—f―g−h-i")).toBe("a-b-c-d-e-f-g-h-i");
	});
	it("двойные кавычки → \"", () => expect(normalizeForSearch("«а» „б“ ”в” ‟г‟ ″д″")).toBe('"а" "б" "в" "г" "д"'));
	it("одинарные кавычки → '", () => expect(normalizeForSearch("‘а’ ‚б‛")).toBe("'а' 'б'"));
	it("неразрывный и тонкие пробелы → пробел", () => {
		expect(normalizeForSearch("а б в г д")).toBe("а б в г д");
	});
	it("длина строки не меняется, даже у «İ» (нижний регистр длиннее)", () => {
		for (const s of ["İstanbul", "Ёлка — «да»", "ǅ ß ŉ", "😀 Ab 😀", ""]) expect(normalizeForSearch(s).length).toBe(s.length);
		expect(normalizeForSearch("İ")).toBe("i");
	});
});

describe("findInBook: запрос", () => {
	const paras = ["Привет, мир", "Второй абзац"];
	it("один символ — пусто", () => {
		expect(find(paras, "п")).toEqual({ matches: [], more: false });
		expect(find(paras, "  п  ").matches).toEqual([]);
		expect(find(paras, "   ").matches).toEqual([]);
		expect(find(paras, "").matches).toEqual([]);
	});
	it("пробелы по краям обрезаны, подряд идущие — один", () => {
		expect(find(paras, "  привет,   мир ").matches.length).toBe(1);
		expect(find(paras, "\t привет,  мир").matches.length).toBe(1);
	});
	it("два символа находятся", () => expect(find(paras, "ми").matches.length).toBe(1));
	it("регистр, ё/е, тире, кавычки, неразрывный пробел", () => {
		const p = ["Он сказал: «Ёлка — зелёная» и ушёл", "Ё-моё"];
		expect(find(p, "ЕЛКА").matches.length).toBe(1);
		expect(find(p, "зеленая").matches.length).toBe(1);
		expect(find(p, 'елка - зеленая').matches.length).toBe(1);
		expect(find(p, '"елка').matches.length).toBe(1);
		expect(find(p, "и ушел").matches.length).toBe(1);
		expect(find(p, "е-мое").matches.length).toBe(1);
	});
});

describe("findInBook: слово совпадения", () => {
	const paras = ["альфа бета гамма", "", "дельта эпсилон"];
	const stream = buildWords(paras);
	it("начало, середина и конец абзаца", () => {
		expect(findInBook(paras, stream, "альфа").matches[0]).toEqual({ para: 0, offset: 0, length: 5, word: 0 });
		expect(findInBook(paras, stream, "бета").matches[0].word).toBe(1);
		expect(findInBook(paras, stream, "гамма").matches[0].word).toBe(2);
	});
	it("внутри слова ведёт на это слово", () => {
		const m = findInBook(paras, stream, "мм").matches[0];
		expect(m.word).toBe(2);
		expect(stream.words[m.word].text).toBe("гамма");
	});
	it("первый и последний абзацы, пустой абзац между ними", () => {
		expect(findInBook(paras, stream, "альф").matches[0].para).toBe(0);
		const last = findInBook(paras, stream, "эпсил").matches[0];
		expect(last.para).toBe(2);
		expect(last.word).toBe(stream.paraStarts[2] + 1);
		expect(stream.words[last.word].text).toBe("эпсилон");
	});
	it("совпадение через два слова: слово — то, где оно началось", () => {
		const m = findInBook(paras, stream, "бета гамма").matches[0];
		expect(m.word).toBe(1);
		expect(m.length).toBe(10);
	});
	it("на стыке абзацев совпадения нет", () => {
		expect(findInBook(paras, stream, "гамма дельта").matches).toEqual([]);
		expect(findInBook(["аб", "вг"], buildWords(["аб", "вг"]), "бв").matches).toEqual([]);
	});
	it("слово совпадает с buildWords, когда тире и кавычки стоят отдельными словами", () => {
		const p = ["— Привет, — сказал он. — «Как дела?»", "« Ёлка » — зелёная"];
		const st = buildWords(p);
		for (const q of ["привет", "сказал", "как дела", "дела?", "елка", "зеленая", "он. —"]) {
			const r = findInBook(p, st, q);
			expect(r.matches.length, q).toBeGreaterThan(0);
			for (const m of r.matches) {
				const w = st.words[m.word].text;
				expect(normalizeForSearch(w), q).toContain(normalizeForSearch(q).split(" ")[0].replace(/^["-]+/, ""));
			}
		}
		// «привет» стоит в слове «— Привет,» — слово 0, а не следующее
		expect(findInBook(p, st, "привет").matches[0].word).toBe(0);
		expect(normalizeForSearch(st.words[findInBook(p, st, "сказал").matches[0].word].text)).toBe("- сказал");
	});
});

describe("findInBook: предел и кэш", () => {
	const many = Array.from({ length: 10 }, (_, i) => `слово слово ${i}`);
	it("limit и more", () => {
		const a = find(many, "слово", 7);
		expect(a.matches.length).toBe(7);
		expect(a.more).toBe(true);
		const b = find(many, "слово", 20);
		expect(b.matches.length).toBe(20);
		expect(b.more).toBe(false);
		const c = find(many, "слово", 19);
		expect(c.matches.length).toBe(19);
		expect(c.more).toBe(true);
	});
	it("по умолчанию 300", () => {
		const big = Array.from({ length: 400 }, () => "аа аа");
		const r = find(big, "аа");
		expect(r.matches.length).toBe(300);
		expect(r.more).toBe(true);
	});
	it("совпадения идут по порядку книги", () => {
		const r = find(many, "слово");
		const words = r.matches.map((m) => m.word);
		expect(words).toEqual([...words].sort((x, y) => x - y));
	});
	it("повторный поиск по тому же массиву даёт тот же результат", () => {
		const st = buildWords(many);
		expect(findInBook(many, st, "слово 3")).toEqual(findInBook(many, st, "слово 3"));
		expect(findInBook(many, st, "слово 3").matches[0].para).toBe(3);
	});
});
