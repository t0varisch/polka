import type { BookFormat, BookImage, TocEntry } from "../types";

/** Версия разбора текста: 1 — до рисунков, 2 — с рисунками. */
export const TEXT_VERSION = 2;

/** Разобранный текст в кэше. v — версия разбора: 1 — до рисунков. */
export interface CachedText {
	paragraphs: string[];
	toc: TocEntry[];
	images: BookImage[];
	v: number;
}

/** Кэш устарел: разобран до рисунков, а в книге такого формата они бывают. */
export function staleText(t: { v: number }, format: BookFormat): boolean {
	return t.v < TEXT_VERSION && (format === "fb2" || format === "epub");
}

/**
 * Пишет текст в кэш вместе с рисунками; если запись с рисунками не вышла (нет места, сбой клонирования),
 * повторяет без них. Так книга не теряется из-за больших картинок: рисунки покажутся в сеансе, где книга разобрана.
 * Повторный сбой пробрасывается, как раньше при сбое записи текста.
 */
export async function putTextSafe(
	put: (id: string, paragraphs: string[], toc: TocEntry[], images: BookImage[]) => Promise<void>,
	id: string,
	paragraphs: string[],
	toc: TocEntry[],
	images: BookImage[],
): Promise<void> {
	try {
		await put(id, paragraphs, toc, images);
	} catch (e) {
		if (!images.length) throw e;
		await put(id, paragraphs, toc, []);
	}
}
