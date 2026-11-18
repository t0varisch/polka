// Разбивка книги на слова и паузы.
// Паузы как в Speeedy (MIT, © 2026 Speeedy) с его настройками по умолчанию: конец предложения ×3,
// запятая ×1.8, начало абзаца ×1.8, закрытие скобки или кавычки ×1.15. Добавлено под русский:
// многоточие, тире в диалогах, кавычки-ёлочки.

export interface Word {
	text: string;
	/** Множитель длительности показа (1 — обычное слово). */
	pause: number;
	/** Слово заканчивает предложение. */
	end: boolean;
	/** Число букв и цифр — для «умной скорости». */
	letters: number;
}

export interface WordStream {
	words: Word[];
	/** Индекс первого слова каждого абзаца. */
	paraStarts: number[];
	/** Индексы начал предложений, по возрастанию. */
	sentenceStarts: number[];
}

/** Насколько сильные паузы: 0 — без пауз, 1 — мягкие, 2 — как в Speeedy, 3 — длинные. */
export type PauseLevel = 0 | 1 | 2 | 3;

const DASHES = /^[—–―-]+$/u;
const ONLY_PUNCT = /^[^\p{L}\p{N}]+$/u;
const OPENERS = /^[«„“"'(\[]+$/u;
const CLOSERS = /[»"”’'\)\]]+$/u;
const LETTER = /[\p{L}\p{N}]/gu;

/** Слово абзаца и индекс его первого символа в исходной строке. */
interface Token {
	text: string;
	start: number;
}

/** Единственная разбивка абзаца на слова: её используют и buildWords, и wordStarts. */
function splitWithStarts(p: string): Token[] {
	const raw: Token[] = [];
	for (const m of p.matchAll(/[^ \t\n\r]+/g)) raw.push({ text: m[0], start: m.index });
	const out: Token[] = [];
	let carry = "";
	let carryStart = 0;
	for (let i = 0; i < raw.length; i++) {
		const { text: t, start } = raw[i];
		if (DASHES.test(t) || OPENERS.test(t)) {
			// Тире и открывающая кавычка уходят к следующему слову: «— Привет»
			if (!carry) carryStart = start;
			carry += t + (DASHES.test(t) ? " " : "");
			continue;
		}
		if (ONLY_PUNCT.test(t) && out.length > 0 && !carry) {
			// Отбившаяся пунктуация («слово ,», «…») — к предыдущему слову
			out[out.length - 1].text += t;
			continue;
		}
		out.push({ text: carry + t, start: carry ? carryStart : start });
		carry = "";
	}
	if (carry) {
		if (out.length > 0) out[out.length - 1].text += " " + carry.trim();
		else out.push({ text: carry.trim(), start: carryStart });
	}
	return out;
}

function splitParagraph(p: string): string[] {
	return splitWithStarts(p).map((t) => t.text);
}

/** Индексы первых символов слов абзаца в исходной строке; та же разбивка, что в buildWords. */
export function wordStarts(paragraph: string): number[] {
	return splitWithStarts(paragraph).map((t) => t.start);
}

/** Базовая сила знака в конце слова: 2 — конец предложения, 1.4 — внутри, 1 — нет. */
function punctWeight(text: string): { weight: number; end: boolean; closes: boolean } {
	const closes = CLOSERS.test(text);
	const core = text.replace(CLOSERS, "");
	const last = core.slice(-1);
	if (last === "." || last === "!" || last === "?" || last === "…") return { weight: 2, end: true, closes };
	if (last === "," || last === ";" || last === ":" || last === "—" || last === "–") return { weight: 1.4, end: false, closes };
	if (closes) return { weight: 1.4, end: false, closes };
	return { weight: 1, end: false, closes };
}

const LEVEL_FACTOR: Record<PauseLevel, number> = { 0: 0, 1: 1, 2: 2, 3: 3 };

export function buildWords(paragraphs: string[], level: PauseLevel = 2): WordStream {
	const words: Word[] = [];
	const paraStarts: number[] = [];
	const sentenceStarts: number[] = [];
	const k = LEVEL_FACTOR[level];
	const paraMult = level === 0 ? 1 : 1 + 0.4 * k; // при уровне 2 — 1.8, как в Speeedy

	for (const p of paragraphs) {
		paraStarts.push(words.length);
		const tokens = splitParagraph(p);
		for (let i = 0; i < tokens.length; i++) {
			const text = tokens[i];
			const pw = punctWeight(text);
			let weight = pw.weight;
			// Перед тире в середине фразы — пауза как на запятой
			const next = tokens[i + 1];
			if (weight < 1.4 && next && /^[—–]/.test(next)) weight = 1.4;
			let pause = 1 + (weight - 1) * k;
			if (pw.closes && level > 0) pause *= 1.15;
			if (i === 0 && words.length > 0) pause *= paraMult;
			const end = pw.end || i === tokens.length - 1;
			if (i === 0 || (words.length > 0 && words[words.length - 1].end)) {
				sentenceStarts.push(words.length);
			}
			words.push({ text, pause, end, letters: (text.match(LETTER) ?? []).length });
		}
	}
	// Абзац без слов указывает на следующее слово
	for (let i = 0; i < paraStarts.length; i++) {
		if (paraStarts[i] >= words.length) paraStarts[i] = Math.max(0, words.length - 1);
	}
	return { words, paraStarts, sentenceStarts: dedupe(sentenceStarts) };
}

function dedupe(a: number[]): number[] {
	const out: number[] = [];
	for (const x of a) if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
	return out;
}

/** Множитель «умной скорости»: короткие слова быстрее, длинные медленнее. Как smartWpm в Speeedy, но через длительность. */
export function smartFactor(w: Word): number {
	if (w.letters <= 3) return 1 / 1.3;
	if (w.letters >= 8) return 1 / 0.75;
	if (w.letters >= 6) return 1 / 0.9;
	return 1;
}

/** Последнее начало предложения, не большее index (бинарный поиск). */
export function sentenceStartAt(starts: number[], index: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	let ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] <= index) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}
