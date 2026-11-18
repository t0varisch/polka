// Ядро набора: текст книги → строка, которую можно напечатать с обычной клавиатуры,
// проверка нажатий и подсчёт скорости.

export interface TypingText {
	/** Весь текст; абзацы разделены "\n" (печатается пробелом или Enter). */
	text: string;
	/** Позиция первого символа каждого абзаца. */
	paraStarts: number[];
}

export interface MatchOptions {
	/** Учитывать заглавные буквы. */
	caseSensitive: boolean;
	/** Печатать знаки препинания (иначе они пропускаются сами). */
	punctuation: boolean;
}

/** Типографские знаки → то, что есть на клавиатуре. Длина может меняться (… → ...). */
const REPLACE: [RegExp, string][] = [
	[/[      　\t]/g, " "],
	[/[«»„“”‟″〝〞]/g, '"'],
	[/[‘’‚‛′`´]/g, "'"],
	[/[—–‒―−‐‑⁃]/g, "-"],
	[/…/g, "..."],
	[/[­​-‍﻿]/g, ""],
];

/** Замена для одного символа по таблице REPLACE; считается один раз на символ. */
const REP_CACHE = new Map<string, string>();
function replaceChar(ch: string): string {
	let rep = REP_CACHE.get(ch);
	if (rep === undefined) {
		rep = ch;
		for (const [re, to] of REPLACE) rep = rep.replace(re, to);
		REP_CACHE.set(ch, rep);
	}
	return rep;
}

/**
 * Нормализация абзаца вместе с картой символов: map[i] — индекс в нормализованной строке,
 * куда попал символ i исходной (для p.length — длина результата). Удалённые символы
 * (мягкий перенос, нулевая ширина, лишний пробел) получают индекс следующего оставшегося.
 */
export function normalizeWithMap(p: string): { text: string; map: Int32Array } {
	const map = new Int32Array(p.length + 1);
	const parts: string[] = [];
	let len = 0;
	let lastSpace = false;
	for (let i = 0; i < p.length; i++) {
		map[i] = len;
		const rep = replaceChar(p[i]);
		if (rep === " " && lastSpace) continue; // сдвоенные пробелы схлопываются
		if (rep) {
			parts.push(rep);
			len += rep.length;
			lastSpace = rep[rep.length - 1] === " ";
		}
	}
	const out = parts.join("");
	// trim() как раньше: срезанные с краёв символы сдвигают карту
	const lead = out.length - out.trimStart().length;
	const text = out.trim();
	map[p.length] = len;
	for (let i = 0; i <= p.length; i++) map[i] = Math.min(Math.max(map[i] - lead, 0), text.length);
	return { text, map };
}

export function normalizeParagraph(p: string): string {
	return normalizeWithMap(p).text;
}

export function buildTypingText(paragraphs: string[]): TypingText {
	const parts: string[] = [];
	const paraStarts: number[] = [];
	let len = 0;
	for (const p of paragraphs) {
		const n = normalizeParagraph(p);
		if (!n) {
			paraStarts.push(-1);
			continue;
		}
		if (parts.length) {
			parts.push("\n");
			len += 1;
		}
		paraStarts.push(len);
		parts.push(n);
		len += n.length;
	}
	// Пустой абзац указывает на начало следующего
	for (let i = paraStarts.length - 1, next = len; i >= 0; i--) {
		if (paraStarts[i] < 0) paraStarts[i] = next;
		else next = paraStarts[i];
	}
	return { text: parts.join(""), paraStarts };
}

export type CharKind = "space" | "letter" | "punct" | "skip";

const RU_OR_EN = /[a-zA-Zа-яА-ЯёЁ0-9]/;
const KEYBOARD_PUNCT = new Set(Array.from(".,!?;:-()\"'/%№+=*&@#$^_[]{}<>\\|~"));

export function charKind(ch: string): CharKind {
	if (ch === " " || ch === "\n") return "space";
	if (RU_OR_EN.test(ch)) return "letter";
	if (KEYBOARD_PUNCT.has(ch)) return "punct";
	// Буквы с ударениями, греческий, ©, ° и прочее, чего нет на русской и английской раскладке
	return "skip";
}

/** Нужно ли печатать символ на позиции i (с учётом настроек и сдвоенных пробелов после пропусков). */
export function isRequired(text: string, i: number, opts: MatchOptions): boolean {
	const k = charKind(text[i]);
	if (k === "skip") return false;
	if (k === "punct" && !opts.punctuation) return false;
	if (k === "space") {
		// Пробел, перед которым из нужного тоже пробел (между ними всё пропущено), — лишний
		for (let j = i - 1; j >= 0; j--) {
			if (!isRequiredBasic(text[j], opts)) continue;
			return charKind(text[j]) !== "space";
		}
		return false; // пробел в самом начале
	}
	return true;
}

function isRequiredBasic(ch: string, opts: MatchOptions): boolean {
	const k = charKind(ch);
	return k === "letter" || k === "space" || (k === "punct" && opts.punctuation);
}

/** Следующая позиция, которую надо напечатать, начиная с from (включительно). text.length — конец. */
export function nextRequired(text: string, from: number, opts: MatchOptions): number {
	let i = Math.max(0, from);
	while (i < text.length && !isRequired(text, i, opts)) i++;
	return i;
}

const PUNCT_EQUIV: Record<string, string> = {
	'"': '"«»„“”',
	"'": "'’‘",
	"-": "-—–",
};

export function matches(expected: string, typed: string, opts: MatchOptions): boolean {
	if (expected === typed) return true;
	const k = charKind(expected);
	if (k === "space") return typed === " " || typed === "\n" || typed === "\r";
	if (k === "punct") return (PUNCT_EQUIV[expected] ?? "").includes(typed);
	let e = expected;
	let t = typed;
	if (!opts.caseSensitive) {
		e = e.toLowerCase();
		t = t.toLowerCase();
	}
	if (e === t) return true;
	// «е» вместо «ё» — не ошибка
	if (e === "ё" && t === "е") return true;
	if (e === "Ё" && t === "Е") return true;
	return false;
}

const CYR = /[а-яА-ЯёЁ]/;
const LAT = /[a-zA-Z]/;

/** Подсказка про раскладку, если нажали букву не того алфавита. */
export function layoutHint(expected: string, typed: string): string | null {
	if (CYR.test(expected) && LAT.test(typed)) return "Включена английская раскладка — переключи на русскую";
	if (LAT.test(expected) && CYR.test(typed)) return "Здесь английское слово — переключи раскладку";
	return null;
}

/** Пауза дольше этого не считается временем печати. */
export const IDLE_MS = 3000;

export class TypingStats {
	correct = 0;
	errors = 0;
	activeMs = 0;
	private last = 0;

	hit(ok: boolean, now: number): void {
		if (this.last && now - this.last < IDLE_MS) this.activeMs += now - this.last;
		this.last = now;
		if (ok) this.correct++;
		else this.errors++;
	}

	/** Знаков в минуту (только верные нажатия). */
	get cpm(): number {
		return this.activeMs > 2000 ? Math.round(this.correct / (this.activeMs / 60000)) : 0;
	}

	get accuracy(): number {
		const all = this.correct + this.errors;
		return all ? Math.round((this.correct / all) * 1000) / 10 : 100;
	}
}

/** Сколько символов осталось напечатать от позиции from (для оценки времени). */
export function remainingRequired(text: string, from: number, opts: MatchOptions): number {
	let n = 0;
	for (let i = from; i < text.length; i++) if (isRequiredBasic(text[i], opts)) n++;
	return n;
}
