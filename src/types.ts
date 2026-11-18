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
