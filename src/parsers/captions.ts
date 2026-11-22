// Подписи к рисункам: какой абзац стоит под рисунком как подпись. Текст книги не меняется — подпись только флаг на рисунке.
import type { BookImage } from "../types";

const MAX_CAPTION = 300;
const MAX_SHORT = 80;
/** Слово подписи в начале: «Рис. 1», «Таблица 2», «Figure 3» */
const WORD_RE = /^(рис\.?|рисунок|илл\.?|иллюстрация|схема|табл\.?|таблица|график|диаграмма|фото|карта|fig\.?|figure|table)(\s|\d|$)/i;
const END_RE = /[.!?…:;,]$/;
const LIST_RE = /^([•\-–—*]|\d+[.)]\s)/;

/**
 * Похож ли абзац на подпись к рисунку над ним.
 * marked — книга сама пометила его подписью (subtitle, figcaption, курсив во весь абзац).
 */
export function looksLikeCaption(text: string, marked: boolean): boolean {
	const t = text.trim();
	if (!t || t.length > MAX_CAPTION) return false;
	if (marked) return true;
	if (WORD_RE.test(t)) return true;
	return t.length <= MAX_SHORT && !END_RE.test(t) && !LIST_RE.test(t);
}

/** Весь текст элемента (кроме пробелов) лежит внутри одного из wrappers — «<p><em>Подпись</em></p>». */
export function allTextWrapped(el: Element, tag: (e: Element) => string, wrappers: Set<string>): boolean {
	let inside = false;
	let outside = false;
	const walk = (node: Node, wrapped: boolean): void => {
		for (const c of Array.from(node.childNodes)) {
			if (c.nodeType === 3 || c.nodeType === 4) {
				if (/\S/.test(c.nodeValue ?? "")) {
					if (wrapped) inside = true;
					else outside = true;
				}
			} else if (c.nodeType === 1) {
				walk(c, wrapped || wrappers.has(tag(c as Element)));
			}
		}
	};
	walk(el, false);
	return inside && !outside;
}

/**
 * Ставит caption рисункам, под которыми стоит подпись. blocks[i] — рисунок блочный (не внутри абзаца);
 * marked — индексы абзацев, помеченных самой книгой; skip — абзацы-заголовки.
 * Из рисунков с одним at подпись может получить только последний.
 */
export function applyCaptions(images: BookImage[], blocks: boolean[], paragraphs: string[], marked: Set<number>, skip: Set<number>): void {
	const last = new Map<number, number>();
	images.forEach((im, i) => last.set(im.at, i));
	images.forEach((im, i) => {
		if (!blocks[i] || last.get(im.at) !== i) return;
		const p = im.at;
		if (p >= paragraphs.length || skip.has(p)) return;
		if (looksLikeCaption(paragraphs[p], marked.has(p))) im.caption = true;
	});
}
