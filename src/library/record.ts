import { snippetAt } from "../core/anchor";
import { buildWords } from "../core/words";
import type { BookRecord, ParsedBook } from "../types";

export interface ProgressFile {
	version: 1;
	books: Record<string, BookRecord>;
}

/** Свежая запись: позиция в начале, режим «страницы». */
export function newRecord(id: string, book: ParsedBook, wordCount: number, now: number = Date.now()): BookRecord {
	// первые слова берём из первых абзацев — полный разбор книги не нужен
	const snippet = snippetAt(buildWords(book.paragraphs.slice(0, 20)), 0);
	return {
		id,
		title: book.title,
		author: book.author,
		format: book.format,
		wordCount,
		position: { word: 0, para: 0, snippet, mode: "pages", at: now },
		bookmarks: [],
		typing: { correct: 0, errors: 0, activeMs: 0 },
		addedAt: now,
		openedAt: now,
		updatedAt: now,
	};
}

/** Запись книги заменяется, если на диске её нет или там не новее; остальные книги не трогаем. */
export function mergeProgress(onDisk: ProgressFile | null, rec: BookRecord): ProgressFile {
	const books = { ...(onDisk?.books ?? {}) };
	const old = books[rec.id];
	if (!old || old.updatedAt <= rec.updatedAt) books[rec.id] = rec;
	return { version: 1, books };
}

/** Битый или чужой JSON — пустой файл. */
export function parseProgress(json: string): ProgressFile {
	try {
		const v = JSON.parse(json);
		if (v && v.version === 1 && v.books && typeof v.books === "object" && !Array.isArray(v.books)) return v as ProgressFile;
	} catch {
		// не JSON
	}
	return { version: 1, books: {} };
}
