// Поиск по книге: без учёта регистра, «ё» и вида тире, кавычек и пробелов.
// Нормализация посимвольная и длину строки не меняет, поэтому смещение совпадения в нормализованном
// тексте — то же смещение в исходном абзаце. Номер слова считаем через wordStarts (та же разбивка, что в buildWords).
import { wordStarts, type WordStream } from "./words";

export interface SearchMatch {
	/** Абзац, в котором найдено. */
	para: number;
	/** Индекс первого символа совпадения в исходном абзаце. */
	offset: number;
	/** Длина совпадения в символах (та же, что у запроса после нормализации). */
	length: number;
	/** Номер слова, внутри которого совпадение начинается. */
	word: number;
}

const DASHES = "‐‑‒–—―−";
const DQUOTES = "«»„“”‟″";
const SQUOTES = "‘’‚‛";
const SPACES = "              ";

/** Замены «один символ в один символ» (без нижнего регистра). */
const FOLD = new Map<string, string>();
FOLD.set("ё", "е");
for (const c of DASHES) FOLD.set(c, "-");
for (const c of DQUOTES) FOLD.set(c, '"');
for (const c of SQUOTES) FOLD.set(c, "'");
for (const c of SPACES) FOLD.set(c, " ");
const FOLD_RE = new RegExp(`[ё${DASHES}${DQUOTES}${SQUOTES}${SPACES}]`, "g");

/** Нижний регистр без смены длины: у символа, чей нижний регистр длиннее одного, берём первый символ результата. */
function lowerSameLength(s: string): string {
	const lower = s.toLowerCase();
	if (lower.length === s.length) return lower;
	let out = "";
	for (let i = 0; i < s.length; i++) out += s[i].toLowerCase()[0] ?? s[i];
	return out;
}

export function normalizeForSearch(s: string): string {
	// «Ё» после нижнего регистра уже «ё»; замены однозначные, длина не растёт
	return lowerSameLength(s).replace(FOLD_RE, (c) => FOLD.get(c) ?? c);
}

/** Запрос после нормализации: пробелы по краям обрезаны, подряд идущие — один; короче 2 символов — пусто. */
function normalizeQuery(q: string): string {
	const n = normalizeForSearch(q).replace(/\s+/g, " ").trim();
	return n.length < 2 ? "" : n;
}

/** Нормализованные абзацы считаются один раз на книгу (массив абзацев — ключ). */
const cache = new WeakMap<string[], string[]>();

function normalizedParagraphs(paragraphs: string[]): string[] {
	let norm = cache.get(paragraphs);
	if (!norm) {
		norm = paragraphs.map(normalizeForSearch);
		cache.set(paragraphs, norm);
	}
	return norm;
}

/** Индекс слова, начинающегося не позже offset (starts по возрастанию, не пуст). */
function wordIndexAt(starts: number[], offset: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * Все совпадения запроса в порядке книги, не больше limit; more — есть ещё.
 * Совпадение не пересекает границу абзаца.
 */
export function findInBook(paragraphs: string[], stream: WordStream, query: string, limit = 300): { matches: SearchMatch[]; more: boolean } {
	const q = normalizeQuery(query);
	const matches: SearchMatch[] = [];
	if (!q) return { matches, more: false };
	const norm = normalizedParagraphs(paragraphs);
	for (let para = 0; para < norm.length; para++) {
		const text = norm[para];
		let at = text.indexOf(q);
		if (at < 0) continue;
		const starts = wordStarts(paragraphs[para]);
		if (starts.length === 0) continue;
		for (; at >= 0; at = text.indexOf(q, at + q.length)) {
			if (matches.length >= limit) return { matches, more: true };
			matches.push({ para, offset: at, length: q.length, word: stream.paraStarts[para] + wordIndexAt(starts, at) });
		}
	}
	return { matches, more: false };
}
