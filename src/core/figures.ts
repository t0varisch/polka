// Раскладка рисунков по кускам режима «Страницы» и подбор размера под ширину текста и высоту окна
import type { BookImage } from "../types";
import type { Chunk } from "./chunks";

/**
 * Индексы рисунков для каждого куска. Рисунок стоит перед абзацем `at`:
 * - обычный идёт в кусок, где fromPara < at <= toPara; at на границе — в конец предыдущего куска
 *   (рисунок в конце главы остаётся в своей главе); at = 0 — в первый, at >= paraCount — в последний;
 * - с подписью (caption) идёт в кусок, где лежит абзац `at`, вместе со своей подписью.
 */
export function imagesByChunk(chunks: Chunk[], images: BookImage[], paraCount: number): number[][] {
	const out: number[][] = chunks.map(() => []);
	if (chunks.length === 0) return out;
	images.forEach((im, idx) => {
		const at = Math.max(0, im.at);
		let target = chunks.length - 1;
		if (at >= paraCount) target = chunks.length - 1;
		else if (im.caption) {
			const i = chunks.findIndex((c) => c.fromPara <= at && at < c.toPara);
			target = i >= 0 ? i : 0;
		} else if (at === 0) target = 0;
		else {
			const i = chunks.findIndex((c) => c.fromPara < at && at <= c.toPara);
			target = i >= 0 ? i : chunks.length - 1;
		}
		out[target].push(idx);
	});
	return out;
}

/**
 * Наибольшая высота рисунка при подписи высотой capH: подпись и рисунок вместе не выше окна,
 * рисунок не ниже 3 строк. Подпись длиннее (окно − 3 строки) — null: фигура может разорваться.
 */
export function maxImageHeight(colH: number, lineH: number, capH: number): number | null {
	if (capH > colH - 3 * lineH) return null;
	return Math.max(3 * lineH, Math.floor((colH - capH - 0.5) / lineH) * lineH);
}

/** Уменьшает с сохранением пропорций, не увеличивает; целые пиксели, не меньше 1. */
export function fitSize(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
	if (!(w > 0) || !(h > 0)) return { w: 1, h: 1 };
	const k = Math.min(1, maxW / w, maxH / h);
	return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Ждёт p не дольше ms миллисекунд; не дождались — false (зависший decode не держит запуск страниц). */
export function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		p.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}
