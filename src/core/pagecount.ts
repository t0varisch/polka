// Оценка числа страниц куска и сквозная нумерация страниц по книге.

/** Строки абзаца: 0 для пустого, иначе с красной строкой. */
export function paraLines(chars: number, charsPerLine: number, indentChars = 2): number {
	if (chars <= 0) return 0;
	return Math.ceil((chars + indentChars) / Math.max(1, charsPerLine));
}

/** Страницы куска по длине абзацев; заголовок крупнее в 1.3 раза; не меньше одной. */
export function estimateChunkPages(
	paras: { chars: number; heading: boolean }[],
	extraLines: number,
	g: { charsPerLine: number; linesPerPage: number },
	gapLines = 0,
	indentChars = 2,
): number {
	let lines = extraLines;
	let count = 0;
	for (const p of paras) {
		if (p.chars <= 0) continue;
		count++;
		lines += p.heading ? Math.ceil((p.chars * 1.3) / Math.max(1, g.charsPerLine)) : paraLines(p.chars, g.charsPerLine, indentChars);
	}
	// промежуток — между соседними абзацами
	if (count > 1) lines += (count - 1) * gapLines;
	return Math.max(1, Math.ceil(lines / Math.max(1, g.linesPerPage)));
}

/** Страницы по кускам: оценка, пока кусок не измерен, потом точное число. */
export class PageNumbers {
	private pages: number[];

	constructor(estimates: number[]) {
		this.pages = estimates.slice();
	}

	setMeasured(chunk: number, pages: number): void {
		if (chunk >= 0 && chunk < this.pages.length) this.pages[chunk] = pages;
	}

	/** Сколько страниц во всех кусках до данного. */
	startOf(chunk: number): number {
		let sum = 0;
		for (let i = 0; i < chunk && i < this.pages.length; i++) sum += this.pages[i];
		return sum;
	}

	get total(): number {
		let sum = 0;
		for (const p of this.pages) sum += p;
		return sum;
	}
}

/**
 * Номер страницы (с 1) для слова куска, которого нет в DOM: слово делит кусок на страницы поровну по числу слов.
 * startPages — сколько страниц до куска, toWord — исключительно.
 */
export function pageInChunk(startPages: number, chunkPages: number, fromWord: number, toWord: number, word: number): number {
	const share = (word - fromWord) / Math.max(1, toWord - fromWord);
	return startPages + Math.min(chunkPages - 1, Math.max(0, Math.floor(share * chunkPages))) + 1;
}
