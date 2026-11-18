/** Пункт оглавления. paragraph — индекс в ParsedBook.paragraphs, с которого начинается раздел. */
export interface TocEntry {
	title: string;
	/** 0 — верхний уровень, 1 — вложенный и т.д. */
	level: number;
	paragraph: number;
}

export type BookFormat = "fb2" | "epub" | "txt" | "pdf" | "text";

/** Результат разбора файла: только читаемый текст, без служебного. */
export interface ParsedBook {
	title: string;
	/** Пустая строка, если автор неизвестен. */
	author: string;
	format: BookFormat;
	/** Абзацы чистого текста. Пробелы схлопнуты, пустых абзацев нет. Заголовки глав — тоже абзацы. */
	paragraphs: string[];
	toc: TocEntry[];
}

/** Режим чтения одной книги. */
export type Mode = "pages" | "words" | "typing";

/** Место в книге: общая единица — индекс слова в buildWords; остальное помогает найти его после смены разбора. */
export interface Position {
	word: number;
	/** Абзац, в котором слово. */
	para: number;
	/** Первые слова с этого места — чтобы найти его, если число слов изменилось. */
	snippet: string;
	/** В каком режиме остановились. */
	mode: Mode;
	/** Когда сохранено, мс с эпохи. */
	at: number;
}

/** Закладка: слово, на которое поставили метку. */
export interface Bookmark {
	id: string;
	word: number;
	snippet: string;
	createdAt: number;
}

/** Запись о книге — один формат и в папке (.polka/progress.json), и в браузере. */
export interface BookRecord {
	/** Хеш содержимого файла (или текста). */
	id: string;
	/** Имя файла в папке; в браузере нет. */
	file?: string;
	size?: number;
	mtime?: number;
	title: string;
	author: string;
	format: BookFormat;
	wordCount: number;
	position: Position;
	bookmarks: Bookmark[];
	typing: { correct: number; errors: number; activeMs: number };
	addedAt: number;
	openedAt: number;
	updatedAt: number;
}

/** Открытая книга: запись, текст и оглавление. */
export interface OpenedBook {
	record: BookRecord;
	paragraphs: string[];
	toc: TocEntry[];
}
