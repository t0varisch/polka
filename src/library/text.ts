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
