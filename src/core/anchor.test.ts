import { describe, expect, it } from "vitest";
import type { ParsedBook } from "../types";
import { parseFile, type PdfjsModule } from "../parsers/index";
import { buildTypingMap, makePosition, paraOfWord, resolvePosition, snippetAt } from "./anchor";
import { buildTypingText, normalizeParagraph, normalizeWithMap } from "./typing";
import { buildWords, wordStarts } from "./words";

describe("wordStarts", () => {
	for (const p of ["«Привет», — сказал он…", "два  пробела\tи   табуляция ,  хвост", "— — тире"]) {
		it(`как buildWords: ${JSON.stringify(p)}`, () => {
			const starts = wordStarts(p);
			expect(starts.length).toBe(buildWords([p]).words.length);
			for (const s of starts) expect(/\S/.test(p[s])).toBe(true);
			for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
		});
	}
	it("диалог: тире входит в слово, начало — на тире", () => {
		expect(wordStarts("— Привет, мир")).toEqual([0, 10]);
	});
});

describe("normalizeWithMap", () => {
	it("многоточие и монотонность", () => {
		const { text, map } = normalizeWithMap("a…b");
		expect(text).toBe("a...b");
		expect(map[2]).toBe(4);
		for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
		expect(map[3]).toBe(5);
	});
	it("мягкий перенос и нулевая ширина — индекс следующего символа", () => {
		const a = normalizeWithMap("ab­cd");
		expect(a.text).toBe("abcd");
		expect(a.map[2]).toBe(a.map[3]);
		const b = normalizeWithMap("ab​cd");
		expect(b.map[2]).toBe(b.map[3]);
	});
	it("пробелы по краям и сдвоенные", () => {
		const { text, map } = normalizeWithMap("  a   b  ");
		expect(text).toBe("a b");
		expect(map[0]).toBe(0);
		expect(map[2]).toBe(0);
		expect(map[9]).toBe(3);
	});
	it("текст совпадает с normalizeParagraph", () => {
		for (const p of ["«Привет», — сказал он…", "10 000  руб.", "  x ​ y­ "]) {
			expect(normalizeWithMap(p).text).toBe(normalizeParagraph(p));
		}
	});
});

const PARAS = ["", "«Ёлка» — это… ёлка", "***", "Hello, world!", "Текст с неразрывным и мяг­ким", ""];

function roundTrip(paras: string[]): void {
	const stream = buildWords(paras);
	const tt = buildTypingText(paras);
	const m = buildTypingMap(paras, stream, tt);
	let prev = -1;
	for (let w = 0; w < stream.words.length; w++) {
		const c = m.wordToChar(w);
		if (c < prev) throw new Error(`wordToChar убывает на слове ${w}`);
		prev = c;
		const back = m.charToWord(c);
		if (back !== w) throw new Error(`слово ${w} → ${c} → ${back}`);
	}
}

describe("buildTypingMap", () => {
	it("туда-обратно на наборе абзацев", () => roundTrip(PARAS));

	it("середина слова и перевод строки", () => {
		const paras = ["Раз два", "", "три четыре"];
		const stream = buildWords(paras);
		const tt = buildTypingText(paras);
		const m = buildTypingMap(paras, stream, tt);
		expect(m.charToWord(m.wordToChar(1) + 1)).toBe(1);
		const nl = tt.text.indexOf("\n");
		expect(m.charToWord(nl)).toBe(1);
		expect(m.charToWord(nl + 1)).toBe(2);
		expect(m.charToWord(tt.text.length)).toBe(3);
	});
});

describe("resolvePosition", () => {
	const para = (n: number, pre: string) => Array.from({ length: n }, (_, i) => `${pre}${i}`).join(" ");
	const base = ["один два три", "альфа бета гамма дельта", "ёж змея лиса волк", "конец книги здесь"];

	it("число слов совпало — то же слово", () => {
		const s = buildWords(base);
		expect(resolvePosition(s, makePosition(s, 5, "words", 1), s.words.length)).toBe(5);
	});

	it("вставлен абзац из 50 слов — находит по обрывку", () => {
		const s0 = buildWords(base);
		const pos = makePosition(s0, 5, "pages", 1);
		const s1 = buildWords([para(50, "новое"), ...base]);
		expect(resolvePosition(s1, pos, s0.words.length)).toBe(5 + 50);
	});

	it("обрывок не найден — начало абзаца", () => {
		const s0 = buildWords(base);
		const pos = makePosition(s0, 5, "pages", 1);
		const s1 = buildWords(["один два три", "альфа бета гамма дельта", "совсем другое тут", "конец книги здесь"]);
		expect(resolvePosition(s1, pos, s0.words.length)).toBe(s1.paraStarts[pos.para]);
	});

	it("абзаца нет — пропорционально", () => {
		const s0 = buildWords([para(100, "а"), para(100, "б")]);
		const pos = { ...makePosition(s0, 150, "words", 1), para: 99 };
		const s1 = buildWords([para(50, "в")]);
		expect(resolvePosition(s1, pos, 200)).toBe(38);
	});

	it("paraOfWord: хвост и пустые абзацы", () => {
		const a = buildWords(["a b c", ""]);
		expect(paraOfWord(a, 2)).toBe(0);
		const b = buildWords(["a b", "", "c"]);
		expect(paraOfWord(b, 2)).toBe(2);
		const c = buildWords(["a b", "", "", "c d", "", ""]);
		expect([0, 1, 2, 3].map((w) => paraOfWord(c, w))).toEqual([0, 0, 3, 3]);
	});

	it("paraOfWord, snippetAt, makePosition", () => {
		const s = buildWords(["a b", "", "c d e"]);
		expect(paraOfWord(s, 0)).toBe(0);
		expect(paraOfWord(s, 2)).toBe(2);
		expect(snippetAt(s, 1, 3)).toBe("b c d");
		expect(makePosition(s, 3, "typing", 7)).toEqual({ word: 3, para: 2, snippet: "d e", mode: "typing", at: 7 });
	});
});

// Настоящие книги: тот же REAL_BOOKS, что в parsers/real-books.test.ts (файлы только читаются)
const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const paths = (env.REAL_BOOKS ?? "")
	.split(";")
	.map((s) => s.trim())
	.filter(Boolean);
const FS = "node:fs";
const loadLegacyPdfjs = async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;

describe.skipIf(!paths.length)("туда-обратно на настоящих книгах", () => {
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop()!;
		it(name, async () => {
			const fs = (await import(/* @vite-ignore */ FS)) as { readFileSync(p: string): Uint8Array };
			const bytes = new Uint8Array(fs.readFileSync(path));
			const book: ParsedBook = await parseFile(new File([bytes as BlobPart], name), { pdfjs: loadLegacyPdfjs });
			roundTrip(book.paragraphs);
		}, 120000);
	}
});
