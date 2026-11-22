import { buildWords } from "../core/words";
import { parseFile, readBytes } from "../parsers";
import type { BookImage, BookRecord, OpenedBook, ParsedBook, TocEntry } from "../types";
import { getText, putText } from "./db";
import { bookId } from "./hash";
import { type CachedText, TEXT_VERSION, staleText } from "./text";
import { type ProgressFile, mergeProgress, newRecord, parseProgress, serializeProgress } from "./record";
import type { Library, ParseProgress, ShelfItem } from "./types";

export const SERVICE_DIR = ".polka";
export const PROGRESS_FILE = "progress.json";
export const BOOK_FILE = /\.(fb2|fb2\.zip|epub|txt|pdf)$/i;
const MAX_DEPTH = 3;

/** Кэш разобранных текстов; в приложении — IndexedDB, в тестах — память. */
export interface TextCache {
	get(id: string): Promise<CachedText | null>;
	put(id: string, paragraphs: string[], toc: TocEntry[], images: BookImage[]): Promise<void>;
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
		try {
			await this.walk(this.dir, "", 0, files, true);
		} catch (e) {
			if (isNotFound(e)) throw new Error(`Папка «${this.name}» недоступна — выбери её снова`);
			throw e;
		}
		const records = Object.values((await this.readProgress()).books);
		const same = (r: BookRecord, f: FoundFile) => r.size === f.size && r.mtime === f.mtime;
		const claimed = new Set<string>();
		const items: ShelfItem[] = [];
		const stale = (a: BookRecord, b: BookRecord) => b.openedAt - a.openedAt;
		// сначала файлы, у которых путь, размер и дата совпали: так замена файла по тому же пути не отнимает запись у настоящего
		const exact = new Map<string, BookRecord>();
		for (const f of files) {
			const r = records.filter((x) => x.file === f.path && same(x, f) && !claimed.has(x.id)).sort(stale)[0];
			if (r) {
				claimed.add(r.id);
				exact.set(f.path, r);
			}
		}
		for (const f of files) {
			let rec = exact.get(f.path);
			let key = rec ? rec.id : "";
			if (!rec) {
				// тот же путь, но файл изменился — открывать нужно через хеш, старый текст из кэша не годится
				rec = records.filter((x) => x.file === f.path && !claimed.has(x.id)).sort(stale)[0];
				// файл переложили в другую папку: то же имя, размер и дата
				if (!rec) rec = records.find((r) => r.file && !claimed.has(r.id) && baseName(r.file) === f.name && same(r, f));
				if (rec) claimed.add(rec.id);
				key = "f:" + f.path;
			}
			items.push({ key, record: rec ?? null, fileName: f.name, path: f.path });
		}
		items.sort((a, b) => {
			if (a.record && b.record) return b.record.openedAt - a.record.openedAt;
			if (a.record) return -1;
			if (b.record) return 1;
			return (a.fileName ?? "").localeCompare(b.fileName ?? "", "ru");
		});
		return items;
	}

	/** Запись книги из progress.json; null — записи нет. */
	async record(id: string): Promise<BookRecord | null> {
		return (await this.readProgress()).books[id] ?? null;
	}

	async open(key: string, p?: ParseProgress): Promise<OpenedBook> {
		const now = Date.now();
		if (key.startsWith("f:")) return this.openByPath(key.slice(2), now, p);
		const record = (await this.readProgress()).books[key];
		if (!record) throw new Error("Книга не найдена");
		let text = await this.cache.get(key);
		if (!text || staleText(text, record.format)) {
			let file: File | null = null;
			try {
				if (record.file) file = await this.fileAt(record.file);
			} catch (e) {
				if (!isNotFound(e)) throw e;
			}
			if (file && text) {
				// кэш устарел: перечитываем, только если по пути лежит та же книга и файл разбирается
				try {
					if ((await bookId(await readBytes(file))) === key) {
						const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
						text = await this.cacheParsed(key, book);
					} else {
						text = { ...text, images: [] };
					}
				} catch {
					text = { ...text, images: [] };
				}
			} else if (file) {
				const book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
				text = await this.cacheParsed(key, book);
			} else if (text) {
				// файла нет, а старый текст есть — открываем его без рисунков
				text = { ...text, images: [] };
			} else if (!record.file) {
				throw new Error("Файл книги не найден в папке");
			} else {
				throw new Error("Файл книги не найден в папке — возможно, его переместили или удалили");
			}
		}
		const opened: BookRecord = { ...record, openedAt: now, updatedAt: Math.max(now, record.updatedAt + 1) };
		await this.save(opened);
		return { record: opened, paragraphs: text.paragraphs, toc: text.toc, images: text.images };
	}

	/** Кладёт свежий разбор в кэш и отдаёт его же как текст книги. */
	private async cacheParsed(id: string, book: ParsedBook): Promise<CachedText> {
		const images = book.images ?? [];
		await this.cache.put(id, book.paragraphs, book.toc, images);
		return { paragraphs: book.paragraphs, toc: book.toc, images, v: TEXT_VERSION };
	}

	save(record: BookRecord): Promise<void> {
		const run = this.chain.then(() =>
			exclusive(async () => {
				const merged = mergeProgress(await this.readProgress(), record);
				await this.writeProgress(merged);
			}),
		);
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

	/** Обход папки и подпапок; служебные папки и папки на точку пропускаем. Нечитаемая запись пропускается, ошибка корня — нет. */
	private async walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, out: FoundFile[], root = false): Promise<void> {
		try {
			for await (const h of dir.values()) {
				try {
					if (h.kind === "directory") {
						if (h.name.startsWith(".") || depth >= MAX_DEPTH) continue;
						await this.walk(h as FileSystemDirectoryHandle, prefix + h.name + "/", depth + 1, out);
					} else if (BOOK_FILE.test(h.name)) {
						// getFile не читает содержимое: размер и дата доступны сразу
						const f = await (h as FileSystemFileHandle).getFile();
						out.push({ path: prefix + h.name, name: h.name, size: f.size, mtime: f.lastModified });
					}
				} catch {
					// один нечитаемый файл или папка не должны ронять всю полку
				}
			}
		} catch (e) {
			if (root) throw e;
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
		if (!existing || !text || staleText(text, existing.format)) {
			try {
				book = await parseFile(file, { onProgress: p?.onProgress, onStage: p?.onStage });
				text = { paragraphs: book.paragraphs, toc: book.toc, images: book.images ?? [], v: TEXT_VERSION };
			} catch (e) {
				// сбой повторного разбора не мешает открыть книгу по старому тексту
				if (!existing || !text) throw e;
				book = null;
				text = { ...text, images: [] };
			}
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
		if (book) await this.cache.put(id, text.paragraphs, text.toc, text.images);
		await this.save(record);
		return { record, paragraphs: text.paragraphs, toc: text.toc, images: text.images };
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

	/** Нет файла — пустой прогресс. Файл есть, но не читается — ProgressError, и писать поверх него нельзя. */
	private async readProgress(): Promise<ProgressFile> {
		let text: string;
		try {
			const sub = await this.dir.getDirectoryHandle(SERVICE_DIR);
			const file = await (await sub.getFileHandle(PROGRESS_FILE)).getFile();
			text = new TextDecoder().decode(await readBytes(file));
		} catch (e) {
			if (isNotFound(e)) return { version: 1, books: {} };
			throw e;
		}
		return parseProgress(text);
	}

	private async writeProgress(data: ProgressFile): Promise<void> {
		const sub = await this.dir.getDirectoryHandle(SERVICE_DIR, { create: true });
		const w = await (await sub.getFileHandle(PROGRESS_FILE, { create: true })).createWritable();
		await w.write(serializeProgress(data));
		await w.close();
	}
}

/** Чтение-слияние-запись progress.json: между вкладками — через Web Locks, где они есть. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
	const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
	return locks ? locks.request("polka-progress", fn) : fn();
}
