// Перевод места между режимами. Общая единица — индекс слова в buildWords; в режиме набора
// место — позиция в нормализованном тексте (buildTypingText), поэтому нужна карта между ними.
import type { Mode, Position } from "../types";
import { normalizeWithMap, type TypingText } from "./typing";
import { wordStarts, type WordStream } from "./words";

/** Последний индекс i, где a[i] ≤ x (0, если таких нет). */
function lastAtMost(a: ArrayLike<number>, x: number): number {
	let lo = 0;
	let hi = a.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] <= x) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

/**
 * Абзац, в котором лежит слово. У пустых абзацев начало общее со следующим — берётся последний (непустой);
 * исключение — хвост книги, где пустые абзацы прижаты к последнему слову: там берётся первый из них.
 */
export function paraOfWord(stream: WordStream, word: number): number {
	const starts = stream.paraStarts;
	if (!starts.length) return 0;
	const p = lastAtMost(starts, word);
	if (starts[p] < stream.words.length - 1) return p;
	const v = starts[p];
	let lo = 0;
	let hi = p;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] >= v) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** Первые n слов с позиции word через пробел. */
export function snippetAt(stream: WordStream, word: number, n = 8): string {
	return stream.words
		.slice(word, word + n)
		.map((w) => w.text)
		.join(" ");
}

export function makePosition(stream: WordStream, word: number, mode: Mode, now: number = Date.now()): Position {
	return { word, para: paraOfWord(stream, word), snippet: snippetAt(stream, word), mode, at: now };
}

const SNIPPET_WORDS = 3;

/**
 * Слово, к которому вернуться. Число слов совпало — pos.word как есть; иначе ищем первые три слова
 * обрывка в абзацах pos.para ± 3, не нашли — начало абзаца, нет абзаца — пропорционально.
 */
export function resolvePosition(stream: WordStream, pos: Position, savedWordCount: number): number {
	const total = stream.words.length;
	if (total === 0) return 0;
	const clamp = (w: number) => Math.min(Math.max(w, 0), total - 1);
	if (savedWordCount === total) return clamp(pos.word);

	const prefix = pos.snippet.split(" ").slice(0, SNIPPET_WORDS).join(" ");
	const starts = stream.paraStarts;
	if (pos.para >= 0 && pos.para < starts.length) {
		if (prefix) {
			const from = starts[Math.max(0, pos.para - 3)];
			const last = Math.min(starts.length - 1, pos.para + 3);
			const to = last + 1 < starts.length ? starts[last + 1] : total;
			let best = -1;
			for (let w = from; w < to; w++) {
				if (snippetAt(stream, w).split(" ").slice(0, SNIPPET_WORDS).join(" ") !== prefix) continue;
				if (best < 0 || Math.abs(w - pos.word) < Math.abs(best - pos.word)) best = w;
			}
			if (best >= 0) return best;
		}
		return clamp(starts[pos.para]);
	}
	return clamp(savedWordCount > 0 ? Math.round((pos.word / savedWordCount) * total) : 0);
}

export interface TypingMap {
	/** Позиция в тексте набора, где начинается слово. */
	wordToChar(word: number): number;
	/** Слово, в которое попадает позиция текста набора. */
	charToWord(pos: number): number;
}

interface ParaInfo {
	/** Начало абзаца в тексте набора. */
	start: number;
	/** Индекс первого слова абзаца. */
	firstWord: number;
	/** Начала слов в исходной строке абзаца. */
	starts: number[];
	/** Карта: индекс исходной строки → индекс в нормализованной. */
	map: Int32Array;
}

export function buildTypingMap(paragraphs: string[], stream: WordStream, tt: TypingText): TypingMap {
	const total = stream.words.length;
	const paras: ParaInfo[] = [];
	const wordChar: number[] = [];
	let first = 0;
	for (let i = 0; i < paragraphs.length; i++) {
		const starts = wordStarts(paragraphs[i]);
		const { map } = normalizeWithMap(paragraphs[i]);
		const start = tt.paraStarts[i] ?? tt.text.length;
		paras.push({ start, firstWord: first, starts, map });
		for (const s of starts) wordChar.push(start + map[s]);
		first += starts.length;
	}
	// Пустые абзацы делят начало со следующим, а «последний ≤» выбирает непустой
	const paraStarts = paras.map((p) => p.start);

	return {
		wordToChar(word) {
			if (!wordChar.length) return 0;
			return wordChar[Math.min(Math.max(word, 0), wordChar.length - 1)];
		},
		charToWord(pos) {
			if (!paras.length || total === 0) return 0;
			const para = paras[lastAtMost(paraStarts, pos)];
			if (!para.starts.length) return Math.min(Math.max(para.firstWord - 1, 0), total - 1);
			// Исходный индекс: наибольший i с map[i] ≤ смещения
			const orig = lastAtMost(para.map, pos - para.start);
			// Последнее слово абзаца с началом ≤ orig (раньше первого — первое)
			return para.firstWord + lastAtMost(para.starts, orig);
		},
	};
}
