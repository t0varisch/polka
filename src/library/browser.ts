import { buildWords } from "../core/words";
import { parseFile, parseText } from "../parsers";
import type { BookRecord, OpenedBook, ParsedBook } from "../types";
import { db, getText, putText } from "./db";
import { bookId } from "./hash";
import { newRecord } from "./record";
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
		return { record: opened, paragraphs: text.paragraphs, toc: text.toc };
	}

	async save(record: BookRecord): Promise<void> {
		await (await db()).put("books", record);
	}

	async addFiles(files: File[], p?: ParseProgress): Promise<string[]> {
		const keys: string[] = [];
		for (const file of files) {
			const id = await bookId(new Uint8Array(await file.arrayBuffer()));
			if (!(await (await db()).get("books", id))) {
				const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
				await this.store(id, book);
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
		await putText(id, book.paragraphs, book.toc);
		await this.save(newRecord(id, book, wordCount));
	}
}
