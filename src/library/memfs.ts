// Подменная папка в памяти для тестов: повторяет нужную часть File System Access API.

interface MemFile {
	bytes: Uint8Array;
	lastModified: number;
}

function notFound(name: string): DOMException {
	return new DOMException(`${name} не найден`, "NotFoundError");
}

function readBlob(b: Blob): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
		r.onerror = () => reject(r.error);
		r.readAsArrayBuffer(b);
	});
}

/** Общий счётчик чтений содержимого файлов (getFile().arrayBuffer()). */
export interface MemStats {
	contentReads: number;
	/** Сколько следующих записей (write) должны упасть с ошибкой. */
	failWrites: number;
}

export class MemFileHandle {
	readonly kind = "file" as const;
	constructor(
		readonly name: string,
		private dir: MemDirHandle,
	) {}

	async getFile(): Promise<File> {
		const f = this.dir.files.get(this.name);
		if (!f) throw notFound(this.name);
		const file = new File([f.bytes as BlobPart], this.name, { lastModified: f.lastModified });
		const stats = this.dir.stats;
		// считаем только чтение содержимого; size и lastModified бесплатны
		Object.defineProperty(file, "arrayBuffer", {
			value: async () => {
				stats.contentReads++;
				const b = await readBlob(new Blob([f.bytes as BlobPart]));
				return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
			},
		});
		return file;
	}

	async createWritable(): Promise<{ write(data: string | BufferSource | Blob): Promise<void>; close(): Promise<void> }> {
		const chunks: Uint8Array[] = [];
		return {
			write: async (data) => {
				if (this.dir.stats.failWrites > 0) {
					this.dir.stats.failWrites--;
					throw new DOMException("запись не удалась", "NoModificationAllowedError");
				}
				if (typeof data === "string") chunks.push(new TextEncoder().encode(data));
				else if (data instanceof Blob) chunks.push(await readBlob(data));
				else if (ArrayBuffer.isView(data)) chunks.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
				else chunks.push(new Uint8Array(data.slice(0)));
			},
			close: async () => {
				const total = chunks.reduce((n, c) => n + c.length, 0);
				const bytes = new Uint8Array(total);
				let o = 0;
				for (const c of chunks) {
					bytes.set(c, o);
					o += c.length;
				}
				this.dir.files.set(this.name, { bytes, lastModified: this.dir.nextTime() });
			},
		};
	}
}

export class MemDirHandle {
	readonly kind = "directory" as const;
	readonly files = new Map<string, MemFile>();
	readonly dirs = new Map<string, MemDirHandle>();
	private clock: { t: number };

	constructor(
		readonly name: string,
		readonly stats: MemStats = { contentReads: 0, failWrites: 0 },
		clock: { t: number } = { t: 1_700_000_000_000 },
	) {
		this.clock = clock;
	}

	/** Монотонное время: каждая запись получает новую дату изменения. */
	nextTime(): number {
		return (this.clock.t += 1000);
	}

	async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemDirHandle> {
		let d = this.dirs.get(name);
		if (!d) {
			if (!opts?.create) throw notFound(name);
			d = new MemDirHandle(name, this.stats, this.clock);
			this.dirs.set(name, d);
		}
		return d;
	}

	async getFileHandle(name: string, opts?: { create?: boolean }): Promise<MemFileHandle> {
		if (!this.files.has(name)) {
			if (!opts?.create) throw notFound(name);
			this.files.set(name, { bytes: new Uint8Array(0), lastModified: this.nextTime() });
		}
		return new MemFileHandle(name, this);
	}

	async removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(name);
	}

	async *values(): AsyncIterableIterator<MemFileHandle | MemDirHandle> {
		for (const n of [...this.files.keys()]) yield new MemFileHandle(n, this);
		for (const d of [...this.dirs.values()]) yield d;
	}

	// помощники для тестов

	/** Кладёт файл по пути вида "подпапка/Книга.txt" (подпапки создаются). */
	put(path: string, content: string | Uint8Array): void {
		const parts = path.split("/");
		const name = parts.pop() as string;
		let d: MemDirHandle = this;
		for (const p of parts) {
			let n = d.dirs.get(p);
			if (!n) {
				n = new MemDirHandle(p, this.stats, this.clock);
				d.dirs.set(p, n);
			}
			d = n;
		}
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		d.files.set(name, { bytes, lastModified: this.nextTime() });
	}

	/** Переименовывает файл в этой папке, сохраняя содержимое и дату. */
	rename(from: string, to: string): void {
		const f = this.files.get(from);
		if (!f) throw notFound(from);
		this.files.delete(from);
		this.files.set(to, f);
	}

	/** Текст файла по пути или null. */
	text(path: string): string | null {
		const parts = path.split("/");
		const name = parts.pop() as string;
		let d: MemDirHandle | undefined = this;
		for (const p of parts) d = d?.dirs.get(p);
		const f = d?.files.get(name);
		return f ? new TextDecoder().decode(f.bytes) : null;
	}
}

export function createMemFs(name = "Книги"): MemDirHandle {
	return new MemDirHandle(name);
}

export function asDirHandle(d: MemDirHandle): FileSystemDirectoryHandle {
	return d as unknown as FileSystemDirectoryHandle;
}
