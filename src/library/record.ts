import { snippetAt } from "../core/anchor";
import { buildWords } from "../core/words";
import type { Bookmark, BookRecord, ParsedBook } from "../types";

export interface ProgressFile {
	version: 1;
	books: Record<string, BookRecord>;
	/** Записи, которые Полка не поняла: при записи возвращаются в файл как есть. */
	foreign?: Record<string, unknown>;
}

/** Файл прогресса есть, но прочитать его нельзя: писать поверх него нельзя. */
export class ProgressError extends Error {
	constructor(message = "Файл .polka/progress.json не читается — Полка его не трогает. Почини или удали его") {
		super(message);
		this.name = "ProgressError";
	}
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

/** Новее ли `rec` того, что уже сохранено (равные — да: запись той же вкладки). */
export function shouldReplace(old: { updatedAt: number } | null | undefined, rec: { updatedAt: number }): boolean {
	return !old || old.updatedAt <= rec.updatedAt;
}

/** Запись книги заменяется, если на диске её нет или там не новее; остальные книги не трогаем. */
export function mergeProgress(onDisk: ProgressFile | null, rec: BookRecord): ProgressFile {
	const books = { ...(onDisk?.books ?? {}) };
	const foreign = { ...(onDisk?.foreign ?? {}) };
	if (shouldReplace(books[rec.id], rec)) {
		books[rec.id] = rec;
		// непонятная запись той же книги не пропадает: уходит под отдельный ключ
		if (rec.id in foreign) {
			foreign[`${rec.id}~не-прочитана`] = foreign[rec.id];
			delete foreign[rec.id];
		}
	}
	const out: ProgressFile = { version: 1, books };
	if (Object.keys(foreign).length) out.foreign = foreign;
	return out;
}

const MODES = new Set(["pages", "words", "typing"]);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Запись похожа на BookRecord настолько, что с ней можно работать. */
export function isBookRecord(v: unknown): v is BookRecord {
	if (!isObj(v) || typeof v.id !== "string" || typeof v.title !== "string") return false;
	if (!isNum(v.wordCount) || !isNum(v.updatedAt) || !isNum(v.openedAt)) return false;
	const p = v.position;
	if (!isObj(p) || !isNum(p.word) || !isNum(p.para) || typeof p.snippet !== "string" || !MODES.has(p.mode as string)) return false;
	if (!Array.isArray(v.bookmarks) || !v.bookmarks.every((b) => isObj(b) && isNum(b.word) && typeof b.snippet === "string")) return false;
	const t = v.typing;
	return isObj(t) && isNum(t.correct) && isNum(t.errors) && isNum(t.activeMs);
}

/** Необязательные поля закладки: неверные отбрасываются, сама закладка остаётся. */
function cleanBookmark(b: Bookmark): Bookmark {
	const out: Bookmark = { ...b };
	if (out.end !== undefined && !(isNum(out.end) && out.end >= out.word)) delete out.end;
	if (out.quote !== undefined && typeof out.quote !== "string") delete out.quote;
	return out;
}

/** Содержимое progress.json. Не JSON или чужая версия — ProgressError (молча заменить пустым нельзя). Непонятные записи сохраняются в `foreign`. */
export function parseProgress(json: string): ProgressFile {
	let v: unknown;
	try {
		v = JSON.parse(json);
	} catch {
		throw new ProgressError();
	}
	if (!isObj(v) || v.version !== 1 || !isObj(v.books)) throw new ProgressError();
	const books: Record<string, BookRecord> = {};
	const foreign: Record<string, unknown> = {};
	for (const [k, rec] of Object.entries(v.books)) {
		if (isBookRecord(rec) && rec.id === k) {
			rec.bookmarks = rec.bookmarks.map(cleanBookmark);
			books[k] = rec;
		}
		else foreign[k] = rec;
	}
	const out: ProgressFile = { version: 1, books };
	if (Object.keys(foreign).length) out.foreign = foreign;
	return out;
}

/** Текст для записи в progress.json: понятные записи и сохранённые как есть. */
export function serializeProgress(data: ProgressFile): string {
	return JSON.stringify({ version: 1, books: { ...(data.foreign ?? {}), ...data.books } }, null, "	");
}
