// Нарезка книги на куски для режима «Страницы»: колонки CSS считаются только по одному куску, а не по всей книге
import type { WordStream } from "./words";

export interface Chunk {
	fromPara: number;
	/** Не включительно. */
	toPara: number;
	fromWord: number;
	/** Не включительно. */
	toWord: number;
}

export const CHUNK_WORDS = 5000;

/**
 * Граница куска — каждый абзац из оглавления; длинный раздел режется по границам абзацев;
 * абзац длиннее maxWords остаётся одним куском. Куски покрывают все слова без дыр и пересечений.
 */
export function buildChunks(stream: WordStream, paraCount: number, tocParas: number[], maxWords = CHUNK_WORDS): Chunk[] {
	if (paraCount <= 0) return [];
	const total = stream.words.length;
	const wordAt = (p: number) => (p >= paraCount ? total : stream.paraStarts[p]);
	const bounds = [...new Set(tocParas.filter((p) => p > 0 && p < paraCount))].sort((a, b) => a - b);
	bounds.push(paraCount);
	const out: Chunk[] = [];
	const push = (from: number, to: number) => out.push({ fromPara: from, toPara: to, fromWord: wordAt(from), toWord: wordAt(to) });
	let sectionStart = 0;
	for (const end of bounds) {
		let from = sectionStart;
		let count = 0;
		for (let p = sectionStart; p < end; p++) {
			const len = stream.paraLens[p] ?? 0;
			if (count > 0 && count + len > maxWords) {
				push(from, p);
				from = p;
				count = 0;
			}
			count += len;
		}
		push(from, end);
		sectionStart = end;
	}
	return dropEmpty(out);
}

/** Куски без слов (разделы из одних пустых абзацев) присоединяются к соседям: пустой страницы не будет. */
function dropEmpty(chunks: Chunk[]): Chunk[] {
	const out: Chunk[] = [];
	let carryPara = -1;
	for (const c of chunks) {
		if (c.fromWord === c.toWord) {
			if (out.length > 0) out[out.length - 1].toPara = c.toPara;
			else if (carryPara < 0) carryPara = c.fromPara;
			continue;
		}
		out.push(carryPara >= 0 ? { ...c, fromPara: carryPara } : c);
		carryPara = -1;
	}
	return out;
}

/** Индекс куска, в котором лежит слово (за пределами — ближайший крайний). */
export function chunkOfWord(chunks: Chunk[], word: number): number {
	let lo = 0;
	let hi = chunks.length - 1;
	let res = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (chunks[mid].fromWord <= word) {
			res = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return res;
}
