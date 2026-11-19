// Чистая логика оболочки книги: возврат на место после смены разбора и сверка с другой вкладкой
import { makePosition, paraOfWord, resolvePosition } from "../core/anchor";
import type { WordStream } from "../core/words";
import type { Bookmark, BookRecord, Mode } from "../types";

export interface Resume {
	/** Слово, с которого начинаем. */
	start: number;
	/** Число слов в книге изменилось: запись нужно обновить (позиция и закладки пересчитаны). */
	changed: boolean;
	position: BookRecord["position"];
	bookmarks: Bookmark[];
}

/** Куда вернуться при открытии. Если число слов другое — позиция и закладки пересчитываются под новый разбор. */
export function resumeAt(stream: WordStream, record: BookRecord, mode: Mode, now: number = Date.now()): Resume {
	const total = stream.words.length;
	const start = resolvePosition(stream, record.position, record.wordCount);
	if (record.wordCount === total) return { start, changed: false, position: record.position, bookmarks: record.bookmarks };
	const bookmarks = record.bookmarks
		.map((b) => {
			const word = Math.min(Math.max(b.word, 0), total - 1);
			const w = resolvePosition(stream, { word, para: paraOfWord(stream, word), snippet: b.snippet, mode, at: b.createdAt }, record.wordCount);
			return { ...b, word: w };
		})
		.sort((x, y) => x.word - y.word);
	return { start, changed: true, position: makePosition(stream, start, mode, now), bookmarks };
}

/** Что делать, когда вкладка снова на виду: взять запись, сохранённую в другом месте, или оставить свою. */
export function syncDecision(stored: BookRecord | null, mine: { updatedAt: number; dirty: boolean }): "adopt" | "keep" {
	if (!stored || mine.dirty) return "keep";
	return stored.updatedAt > mine.updatedAt ? "adopt" : "keep";
}

/** Время записи: не раньше изменения и строго позже прежней записи — будущая дата в старой записи не заморозит сохранения. */
export function stampUpdated(changedAt: number, prevUpdatedAt: number): number {
	return Math.max(changedAt, prevUpdatedAt + 1);
}
