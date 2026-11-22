/** Пункт оглавления. paragraph — индекс в ParsedBook.paragraphs, с которого начинается раздел. */
export interface TocEntry {
	title: string;
	/** 0 — верхний уровень, 1 — вложенный и т.д. */
	level: number;
	paragraph: number;
}

export type BookFormat = "fb2" | "epub" | "txt" | "pdf" | "text";

/** Рисунок из книги. Стоит перед абзацем at; at === paragraphs.length — после последнего абзаца. */
export interface BookImage {
	at: number;
	/** image/jpeg | image/png | image/gif | image/webp | image/bmp | image/svg+xml */
	mime: string;
	data: Uint8Array;
	/** Размер в пикселях из заголовка файла; 0 и 0 — не узнали. */
	w: number;
	h: number;
	/** Абзац at — подпись этого рисунка: стоит сразу под ним. */
	caption?: boolean;
	/** Подпись из атрибута title у image в FB2 — в текст книги не входит, только показывается под рисунком. */
	title?: string;
}

/** Результат разбора файла: только читаемый текст, без служебного. */
export interface ParsedBook {
	title: string;
	/** Пустая строка, если автор неизвестен. */
	author: string;
	format: BookFormat;
	/** Абзацы чистого текста. Пробелы схлопнуты, пустых абзацев нет. Заголовки глав — тоже абзацы. */
	paragraphs: string[];
	toc: TocEntry[];
	/** Рисунки книги по возрастанию at, при равном at — в порядке документа. Нет поля — рисунков нет. */
	images?: BookImage[];
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

/** Открытая книга: запись, текст, оглавление и рисунки. */
export interface OpenedBook {
	record: BookRecord;
	paragraphs: string[];
	toc: TocEntry[];
	/** Всегда массив; рисунков нет — пустой. */
	images: BookImage[];
}
