import { buildWords } from "../core/words";
import { parseFile, parseText } from "../parsers";
import type { BookRecord, OpenedBook, ParsedBook } from "../types";
import { db, getText, putText } from "./db";
import { bookId } from "./hash";
import { newRecord, shouldReplace } from "./record";
import { staleText } from "./text";
import type { Library, ParseProgress, ShelfItem } from "./types";

/** Библиотека в браузере: записи и тексты в IndexedDB. Ключ книги — её id. */
export class BrowserLibrary implements Library {
	readonly kind = "browser" as const;
	readonly name = "Браузер";

	async list(): Promise<ShelfItem[]> {
		const all = await (await db()).getAll("books");
		all.sort((a, b) => b.openedAt - a.openedAt);
		return all.map((record) => ({ key: record.id, record }));
	}

	async open(key: string, _p?: ParseProgress): Promise<OpenedBook> {
		const d = await db();
		const record = await d.get("books", key);
		const text = await getText(key);
		if (!record || !text) throw new Error("Книга не найдена");
		const opened: BookRecord = { ...record, openedAt: Date.now() };
		await d.put("books", opened);
		return { record: opened, paragraphs: text.paragraphs, toc: text.toc, images: text.images };
	}

	/** Свежее побеждает: запись старее сохранённой не заменяет её. Чтение и запись — в одной транзакции. */
	async save(record: BookRecord): Promise<void> {
		const tx = (await db()).transaction("books", "readwrite");
		const old = await tx.store.get(record.id);
		if (shouldReplace(old, record)) await tx.store.put(record);
		await tx.done;
	}

	async record(id: string): Promise<BookRecord | null> {
		return (await (await db()).get("books", id)) ?? null;
	}

	async addFiles(files: File[], p?: ParseProgress): Promise<string[]> {
		const keys: string[] = [];
		for (const file of files) {
			const id = await bookId(new Uint8Array(await file.arrayBuffer()));
			const existing = await (await db()).get("books", id);
			const cached = existing ? await getText(id) : null;
			if (!existing) {
				const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
				await this.store(id, book);
			} else if (!cached || staleText(cached, existing.format)) {
				// книга есть, а текст пропал или разобран до рисунков: обновляем только текст, запись не трогаем
				const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
				await putText(id, book.paragraphs, book.toc, book.images ?? []);
			}
			keys.push(id);
		}
		return keys;
	}

	async addText(title: string, text: string): Promise<string> {
		const id = await bookId(new TextEncoder().encode(text));
		if (await (await db()).get("books", id)) return id;
		await this.store(id, parseText(text, title));
		return id;
	}

	async remove(key: string): Promise<void> {
		const d = await db();
		const tx = d.transaction(["books", "texts"], "readwrite");
		await Promise.all([tx.objectStore("books").delete(key), tx.objectStore("texts").delete(key), tx.done]);
	}

	/** Считает слова и кладёт запись с текстом. */
	private async store(id: string, book: ParsedBook): Promise<void> {
		const wordCount = buildWords(book.paragraphs).words.length;
		if (!wordCount) throw new Error("в файле не нашлось текста");
		await putText(id, book.paragraphs, book.toc, book.images ?? []);
		await this.save(newRecord(id, book, wordCount));
	}
}
