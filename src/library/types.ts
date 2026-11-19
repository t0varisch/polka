import type { BookRecord, OpenedBook } from "../types";

/** Обратная связь при разборе файла; совместима с параметрами parseFile. */
export interface ParseProgress {
	onProgress?(fraction: number): void;
	onStage?(stage: string): void;
}

export interface ShelfItem {
	key: string;
	record: BookRecord | null;
	fileName?: string;
	path?: string;
}

export interface Library {
	readonly kind: "folder" | "browser";
	/** Имя папки или «Браузер». */
	readonly name: string;
	/** Открытые по openedAt (новые сверху), затем неоткрытые по имени. */
	list(): Promise<ShelfItem[]>;
	open(key: string, p?: ParseProgress): Promise<OpenedBook>;
	save(record: BookRecord): Promise<void>;
	/** Сохранённая запись книги (только чтение); null — записи нет. */
	record(id: string): Promise<BookRecord | null>;
	/** Возвращает ключи книг. */
	addFiles(files: File[], p?: ParseProgress): Promise<string[]>;
	addText(title: string, text: string): Promise<string>;
	/** Только браузер. */
	remove?(key: string): Promise<void>;
}
