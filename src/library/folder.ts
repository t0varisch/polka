import { buildWords } from "../core/words";
import { parseFile, readBytes } from "../parsers";
import type { BookRecord, OpenedBook, ParsedBook, TocEntry } from "../types";
import { getText, putText } from "./db";
import { bookId } from "./hash";
import { type ProgressFile, mergeProgress, newRecord, parseProgress } from "./record";
import type { Library, ParseProgress, ShelfItem } from "./types";

export const SERVICE_DIR = ".polka";
export const PROGRESS_FILE = "progress.json";
export const BOOK_FILE = /\.(fb2|fb2\.zip|epub|txt|pdf)$/i;
const MAX_DEPTH = 3;

/** Кэш разобранных текстов; в приложении — IndexedDB, в тестах — память. */
export interface TextCache {
	get(id: string): Promise<{ paragraphs: string[]; toc: TocEntry[] } | null>;
	put(id: string, paragraphs: string[], toc: TocEntry[]): Promise<void>;
}

export const idbTextCache: TextCache = { get: getText, put: putText };

interface FoundFile {
	path: string;
	name: string;
	size: number;
	mtime: number;
}

function isNotFound(e: unknown): boolean {
	return !!e && (e as { name?: string }).name === "NotFoundError";
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Имя без расширения и само расширение (.fb2.zip считается целиком). */
function splitName(name: string): [string, string] {
	const m = /(\.fb2\.zip|\.[^.]+)$/i.exec(name);
	return m ? [name.slice(0, m.index), m[1]] : [name, ""];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Библиотека в папке на диске: книги — файлы, прогресс — `.polka/progress.json`. Ключ книги — её id или "f:путь". */
export class FolderLibrary implements Library {
	readonly kind = "folder" as const;
	readonly name: string;
	/** Записи в progress.json идут по очереди. */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private dir: FileSystemDirectoryHandle,
		private cache: TextCache = idbTextCache,
	) {
		this.name = dir.name;
	}

	async list(): Promise<ShelfItem[]> {
		const files: FoundFile[] = [];
		await this.walk(this.dir, "", 0, files);
		const records = Object.values((await this.readProgress()).books);
		const byPath = new Map<string, BookRecord>();
		for (const r of records) if (r.file) byPath.set(r.file, r);
		const claimed = new Set<string>();
		const items: ShelfItem[] = [];
		for (const f of files) {
			let rec = byPath.get(f.path);
			// файл переложили в другую папку: то же имя, размер и дата
			if (!rec) rec = records.find((r) => r.file && !claimed.has(r.id) && baseName(r.file) === f.name && r.size === f.size && r.mtime === f.mtime);
			if (rec && claimed.has(rec.id)) rec = undefined;
			if (rec) claimed.add(rec.id);
			items.push({ key: rec ? rec.id : "f:" + f.path, record: rec ?? null, fileName: f.name, path: f.path });
		}
		items.sort((a, b) => {
			if (a.record && b.record) return b.record.openedAt - a.record.openedAt;
			if (a.record) return -1;
			if (b.record) return 1;
			return (a.fileName ?? "").localeCompare(b.fileName ?? "", "ru");
		});
		return items;
	}

	async open(key: string, p?: ParseProgress): Promise<OpenedBook> {
		const now = Date.now();
		if (key.startsWith("f:")) return this.openByPath(key.slice(2), now, p);
		const record = (await this.readProgress()).books[key];
		if (!record) throw new Error("Книга не найдена");
		let text = await this.cache.get(key);
		if (!text) {
			if (!record.file) throw new Error("Файл книги не найден в папке");
			let file: File;
			try {
				file = await this.fileAt(record.file);
			} catch (e) {
				if (isNotFound(e)) throw new Error("Файл книги не найден в папке — возможно, его переместили или удалили");
				throw e;
			}
			const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
			await this.cache.put(key, book.paragraphs, book.toc);
			text = { paragraphs: book.paragraphs, toc: book.toc };
		}
		const opened: BookRecord = { ...record, openedAt: now, updatedAt: Math.max(now, record.updatedAt + 1) };
		await this.save(opened);
		return { record: opened, paragraphs: text.paragraphs, toc: text.toc };
	}

	save(record: BookRecord): Promise<void> {
		const run = this.chain.then(async () => {
			const merged = mergeProgress(await this.readProgress(), record);
			await this.writeProgress(merged);
		});
		// сбой одной записи не должен ломать очередь
		this.chain = run.catch(() => {});
		return run;
	}

	async addFiles(files: File[], p?: ParseProgress): Promise<string[]> {
		const keys: string[] = [];
		for (const file of files) {
			const bytes = await readBytes(file);
			const { name, created } = await this.placeFile(file.name, bytes);
			try {
				keys.push((await this.openByPath(name, Date.now(), p)).record.id);
			} catch (e) {
				// не книга — не оставляем лишний файл в папке
				if (created) await this.dir.removeEntry(name).catch(() => {});
				throw e;
			}
		}
		return keys;
	}

	async addText(title: string, text: string): Promise<string> {
		const safe = title.replace(/[<>:"/\\|?*]/g, "_").trim() || "Без названия";
		const bytes = new TextEncoder().encode(text);
		const { name, created } = await this.placeFile(safe + ".txt", bytes);
		try {
			return (await this.openByPath(name, Date.now())).record.id;
		} catch (e) {
			if (created) await this.dir.removeEntry(name).catch(() => {});
			throw e;
		}
	}

	/** Обход папки и подпапок; служебные папки и папки на точку пропускаем. */
	private async walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, out: FoundFile[]): Promise<void> {
		for await (const h of dir.values()) {
			if (h.kind === "directory") {
				if (h.name.startsWith(".") || depth >= MAX_DEPTH) continue;
				await this.walk(h as FileSystemDirectoryHandle, prefix + h.name + "/", depth + 1, out);
			} else if (BOOK_FILE.test(h.name)) {
				// getFile не читает содержимое: размер и дата доступны сразу
				const f = await (h as FileSystemFileHandle).getFile();
				out.push({ path: prefix + h.name, name: h.name, size: f.size, mtime: f.lastModified });
			}
		}
	}

	private async fileAt(path: string): Promise<File> {
		const parts = path.split("/");
		const name = parts.pop() as string;
		let d = this.dir;
		for (const part of parts) d = await d.getDirectoryHandle(part);
		return (await d.getFileHandle(name)).getFile();
	}

	private async openByPath(path: string, now: number, p?: ParseProgress): Promise<OpenedBook> {
		let file: File;
		try {
			file = await this.fileAt(path);
		} catch (e) {
			if (isNotFound(e)) throw new Error("Файл книги не найден в папке");
			throw e;
		}
		const id = await bookId(await readBytes(file));
		const existing = (await this.readProgress()).books[id];
		const where = { file: path, size: file.size, mtime: file.lastModified };
		let text = await this.cache.get(id);
		let book: ParsedBook | null = null;
		if (!existing || !text) {
			book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
			text = { paragraphs: book.paragraphs, toc: book.toc };
		}
		let record: BookRecord;
		if (existing) {
			// книга уже известна: возможно, файл переименовали или переложили
			record = { ...existing, ...where, openedAt: now, updatedAt: Math.max(now, existing.updatedAt + 1) };
		} else {
			const wordCount = buildWords(text.paragraphs).words.length;
			if (!wordCount) throw new Error("в файле не нашлось текста");
			record = { ...newRecord(id, book as ParsedBook, wordCount, now), ...where };
		}
		if (book) await this.cache.put(id, text.paragraphs, text.toc);
		await this.save(record);
		return { record, paragraphs: text.paragraphs, toc: text.toc };
	}

	/** Кладёт файл в корень папки: имя занято другим содержимым — «Имя (2).ext». Тот же файл повторно не пишется. */
	private async placeFile(fileName: string, bytes: Uint8Array): Promise<{ name: string; created: boolean }> {
		const [stem, ext] = splitName(fileName);
		for (let n = 1; ; n++) {
			const name = n === 1 ? fileName : `${stem} (${n})${ext}`;
			let existing: File | null = null;
			try {
				existing = await (await this.dir.getFileHandle(name)).getFile();
			} catch (e) {
				if (!isNotFound(e)) throw e;
			}
			if (existing) {
				if (existing.size === bytes.length && sameBytes(await readBytes(existing), bytes)) return { name, created: false };
				continue;
			}
			const handle = await this.dir.getFileHandle(name, { create: true });
			try {
				const w = await handle.createWritable();
				await w.write(bytes as BufferSource);
				await w.close();
			} catch (e) {
				// не оставляем пустой файл в папке пользователя
				await this.dir.removeEntry(name).catch(() => {});
				throw e;
			}
			return { name, created: true };
		}
	}

	private async readProgress(): Promise<ProgressFile> {
		try {
			const sub = await this.dir.getDirectoryHandle(SERVICE_DIR);
			const file = await (await sub.getFileHandle(PROGRESS_FILE)).getFile();
			return parseProgress(new TextDecoder().decode(await readBytes(file)));
		} catch (e) {
			if (isNotFound(e)) return parseProgress("");
			throw e;
		}
	}

	private async writeProgress(data: ProgressFile): Promise<void> {
		const sub = await this.dir.getDirectoryHandle(SERVICE_DIR, { create: true });
		const w = await (await sub.getFileHandle(PROGRESS_FILE, { create: true })).createWritable();
		await w.write(JSON.stringify(data, null, "\t"));
		await w.close();
	}
}
