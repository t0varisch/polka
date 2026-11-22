import { describe, expect, it } from "vitest";
import { fb2WithImages, utf8 } from "../parsers/test-fixtures";
import { type TextCache, FolderLibrary, PROGRESS_FILE, SERVICE_DIR } from "./folder";
import { folderStateOf } from "./index";
import { type MemDirHandle, asDirHandle, createMemFs } from "./memfs";
import { parseProgress } from "./record";
import { type CachedText, TEXT_VERSION } from "./text";

const BOOK = (n: number) => `Книга номер ${n}\n\nПервый абзац книги ${n} со словами для счёта.\n\nВторой абзац книги ${n} тоже со словами.`;

/** Кэш в памяти: m — содержимое (можно подложить старую запись), puts — сколько раз в него писали. */
function memCache(): TextCache & { m: Map<string, CachedText>; puts: number } {
	const c = {
		m: new Map<string, CachedText>(),
		puts: 0,
		get: async (id: string) => c.m.get(id) ?? null,
		put: async (id: string, paragraphs: string[], toc: never[], images: CachedText["images"]) => {
			c.puts++;
			c.m.set(id, { paragraphs, toc, images, v: TEXT_VERSION });
		},
	};
	return c;
}

function setup(): { fs: MemDirHandle; lib: FolderLibrary } {
	const fs = createMemFs();
	fs.put("Альфа.txt", BOOK(1));
	fs.put("Бета.txt", BOOK(2));
	fs.put("Гамма.txt", BOOK(3));
	fs.put("notes.docx", "не книга");
	fs.put(".polka/other.txt", "служебное");
	fs.put("подпапка/Ещё.txt", BOOK(4));
	return { fs, lib: new FolderLibrary(asDirHandle(fs), memCache()) };
}

const PROGRESS_PATH = `${SERVICE_DIR}/${PROGRESS_FILE}`;
const progress = (fs: MemDirHandle) => {
	const t = fs.text(PROGRESS_PATH);
	return t === null ? { version: 1 as const, books: {} } : parseProgress(t);
};

describe("FolderLibrary", () => {
	it("list: 4 книги, содержимое не читается", async () => {
		const { fs, lib } = setup();
		const items = await lib.list();
		expect(items.map((i) => i.fileName)).toEqual(["Альфа.txt", "Бета.txt", "Гамма.txt", "Ещё.txt"]);
		expect(items.every((i) => i.record === null)).toBe(true);
		expect(items.find((i) => i.fileName === "Ещё.txt")?.key).toBe("f:подпапка/Ещё.txt");
		expect(fs.stats.contentReads).toBe(0);
		expect(lib.kind).toBe("folder");
		expect(lib.name).toBe("Книги");
	});

	it("открытие f: пишет запись в progress.json, повторный list даёт record", async () => {
		const { fs, lib } = setup();
		const opened = await lib.open("f:Бета.txt");
		const rec = progress(fs).books[opened.record.id];
		expect(rec.file).toBe("Бета.txt");
		expect(rec.size).toBeGreaterThan(0);
		expect(rec.mtime).toBeGreaterThan(0);
		const items = await lib.list();
		expect(items[0].record?.id).toBe(opened.record.id);
		expect(items[0].key).toBe(opened.record.id);
		expect(items.length).toBe(4);
		// по id открывается из кэша
		const again = await lib.open(opened.record.id);
		expect(again.paragraphs).toEqual(opened.paragraphs);
	});

	it("переименованный файл: list не находит, open по f: находит запись по id", async () => {
		const { fs, lib } = setup();
		const { record } = await lib.open("f:Бета.txt");
		const position = { ...record.position, word: 5, para: 1 };
		const bookmarks = [{ id: "b1", word: 3, snippet: "метка", createdAt: 1 }];
		await lib.save({ ...record, position, bookmarks, updatedAt: record.updatedAt + 10 });
		fs.rename("Бета.txt", "Новая.txt");
		const items = await lib.list();
		expect(items.find((i) => i.fileName === "Новая.txt")?.record).toBeNull();
		expect(items.some((i) => i.record)).toBe(false);
		const reopened = await lib.open("f:Новая.txt");
		expect(reopened.record.id).toBe(record.id);
		expect(progress(fs).books[record.id].file).toBe("Новая.txt");
		expect(Object.keys(progress(fs).books).length).toBe(1);
		expect(reopened.record.position).toEqual(position);
		expect(reopened.record.bookmarks).toEqual(bookmarks);
		expect(progress(fs).books[record.id].position).toEqual(position);
		expect(progress(fs).books[record.id].bookmarks).toEqual(bookmarks);
	});

	it("save двух книг подряд без ожидания — обе в файле", async () => {
		const { fs, lib } = setup();
		const a = (await lib.open("f:Альфа.txt")).record;
		const b = (await lib.open("f:Гамма.txt")).record;
		await Promise.all([lib.save({ ...a, updatedAt: a.updatedAt + 10 }), lib.save({ ...b, updatedAt: b.updatedAt + 10 })]);
		const books = progress(fs).books;
		expect(Object.keys(books).sort()).toEqual([a.id, b.id].sort());
	});

	it("addFiles с занятым именем — Имя (2).txt", async () => {
		const { fs, lib } = setup();
		const file = new File([BOOK(9)], "Альфа.txt", { type: "text/plain" });
		const keys = await lib.addFiles([file]);
		expect(keys.length).toBe(1);
		expect(fs.text("Альфа (2).txt")).toBe(BOOK(9));
		expect(fs.text("Альфа.txt")).toBe(BOOK(1));
		expect(progress(fs).books[keys[0]].file).toBe("Альфа (2).txt");
	});

	it("addText: запрещённые символы заменяются на _", async () => {
		const { fs, lib } = setup();
		const id = await lib.addText("a/b:c", "Вставленный текст для проверки.");
		expect(fs.text("a_b_c.txt")).toBe("Вставленный текст для проверки.");
		expect(progress(fs).books[id].file).toBe("a_b_c.txt");
	});

	function* listAll(d: MemDirHandle, prefix: string): Generator<string> {
		for (const [n, f] of [...d.files].sort()) yield `${prefix}${n}:${new TextDecoder().decode(f.bytes)}`;
		for (const [n, sub] of [...d.dirs].sort()) yield* listAll(sub, `${prefix}${n}/`);
	}
	const snapshot = (fs: MemDirHandle) => JSON.stringify([...listAll(fs, "")]);
	const EMPTY = "   \n\n  ";

	it("addFiles: файл без текста — отказ, папка как была", async () => {
		const { fs, lib } = setup();
		const before = snapshot(fs);
		await expect(lib.addFiles([new File([EMPTY], "Пусто.txt")])).rejects.toThrow();
		expect(snapshot(fs)).toBe(before);
	});

	it("addFiles: отказ при занятом имени — старый файл цел, «(2)» не остаётся", async () => {
		const { fs, lib } = setup();
		await expect(lib.addFiles([new File([EMPTY], "Альфа.txt")])).rejects.toThrow();
		expect(fs.text("Альфа.txt")).toBe(BOOK(1));
		expect(fs.text("Альфа (2).txt")).toBeNull();
	});

	it("addFiles: отказ при таком же файле в папке — файл не удаляется", async () => {
		const { fs, lib } = setup();
		fs.put("Пусто.txt", EMPTY);
		await expect(lib.addFiles([new File([EMPTY], "Пусто.txt")])).rejects.toThrow();
		expect(fs.text("Пусто.txt")).toBe(EMPTY);
		expect(fs.text("Пусто (2).txt")).toBeNull();
	});

	it("addText: текст без слов — отказ, .txt не остаётся", async () => {
		const { fs, lib } = setup();
		await expect(lib.addText("Пустая", EMPTY)).rejects.toThrow();
		expect(fs.text("Пустая.txt")).toBeNull();
	});

	it("сбой записи нового файла не оставляет пустой файл", async () => {
		const { fs, lib } = setup();
		fs.stats.failWrites = 1;
		await expect(lib.addFiles([new File([BOOK(7)], "Новая.txt")])).rejects.toThrow();
		expect(fs.text("Новая.txt")).toBeNull();
	});

	it("save: упавшая запись отклоняется, следующая проходит", async () => {
		const { fs, lib } = setup();
		const rec = (await lib.open("f:Альфа.txt")).record;
		fs.stats.failWrites = 1;
		await expect(lib.save({ ...rec, updatedAt: rec.updatedAt + 10 })).rejects.toThrow();
		await lib.save({ ...rec, updatedAt: rec.updatedAt + 20 });
		expect(progress(fs).books[rec.id].updatedAt).toBe(rec.updatedAt + 20);
	});
});

describe("FolderLibrary: надёжность", () => {
	const opened = async () => {
		const { fs, lib } = setup();
		const rec = (await lib.open("f:Альфа.txt")).record;
		return { fs, lib, rec };
	};

	it("битый progress.json: read и save отказывают, файл не меняется", async () => {
		const { fs, lib, rec } = await opened();
		for (const bad of ["{ не json", '{"version":2,"books":{}}', "", "null", '{"version":1,"books":[]}']) {
			fs.put(PROGRESS_PATH, bad);
			await expect(lib.save({ ...rec, updatedAt: rec.updatedAt + 5 })).rejects.toThrow(/progress\.json/);
			await expect(lib.list()).rejects.toThrow(/progress\.json/);
			await expect(lib.open("f:Бета.txt")).rejects.toThrow(/progress\.json/);
			expect(fs.text(PROGRESS_PATH)).toBe(bad);
		}
	});

	it("запись с мусором внутри возвращается в файл как есть", async () => {
		const { fs, lib, rec } = await opened();
		const file = JSON.parse(fs.text(PROGRESS_PATH) as string);
		file.books.broken = { id: "broken", title: 42, чужое: [1, 2] };
		file.books.cut = "строка";
		fs.put(PROGRESS_PATH, JSON.stringify(file));
		await lib.save({ ...rec, updatedAt: rec.updatedAt + 5 });
		const after = JSON.parse(fs.text(PROGRESS_PATH) as string);
		expect(after.books.broken).toEqual({ id: "broken", title: 42, чужое: [1, 2] });
		expect(after.books.cut).toBe("строка");
		expect(after.books[rec.id].updatedAt).toBe(rec.updatedAt + 5);
		expect((await lib.list()).filter((i) => i.record).length).toBe(1);
	});

	it("переложенный файл + пустой кэш: list даёт f:, open работает и обновляет file", async () => {
		const fs = createMemFs();
		fs.put("Альфа.txt", BOOK(1));
		const lib = new FolderLibrary(asDirHandle(fs), memCache());
		const rec = (await lib.open("f:Альфа.txt")).record;
		// перенос в подпапку с сохранением даты изменения
		const moved = fs.files.get("Альфа.txt")!;
		fs.files.delete("Альфа.txt");
		fs.put("кладовка/Альфа.txt", moved.bytes);
		fs.dirs.get("кладовка")!.files.get("Альфа.txt")!.lastModified = moved.lastModified;
		const fresh = new FolderLibrary(asDirHandle(fs), memCache());
		const items = await fresh.list();
		expect(items.length).toBe(1);
		expect(items[0].key).toBe("f:кладовка/Альфа.txt");
		expect(items[0].record?.id).toBe(rec.id);
		const again = await fresh.open(items[0].key);
		expect(again.record.id).toBe(rec.id);
		expect(progress(fs).books[rec.id].file).toBe("кладовка/Альфа.txt");
	});

	it("тот же путь, но файл заменён: ключ f:, открытие перехеширует", async () => {
		const fs = createMemFs();
		fs.put("Альфа.txt", BOOK(1));
		const lib = new FolderLibrary(asDirHandle(fs), memCache());
		const rec = (await lib.open("f:Альфа.txt")).record;
		expect((await lib.list())[0].key).toBe(rec.id);
		fs.put("Альфа.txt", BOOK(1) + "\n\nДописанный абзац, из-за которого файл стал другим");
		const items = await lib.list();
		expect(items[0].key).toBe("f:Альфа.txt");
		expect(items[0].record?.id).toBe(rec.id);
		const next = await lib.open(items[0].key);
		expect(next.record.id).not.toBe(rec.id);
		expect(next.paragraphs.join(" ")).toContain("Дописанный");
	});

	it("нечитаемая подпапка не роняет список", async () => {
		const { fs, lib } = setup();
		const sub = fs.dirs.get("подпапка") as MemDirHandle;
		sub.values = async function* () {
			throw new Error("Failed to read");
		};
		const items = await lib.list();
		expect(items.map((i) => i.fileName)).toEqual(["Альфа.txt", "Бета.txt", "Гамма.txt"]);
	});

	it("корневая папка исчезла: русское сообщение", async () => {
		const { fs, lib } = setup();
		fs.values = async function* () {
			throw new DOMException("not found", "NotFoundError");
		};
		await expect(lib.list()).rejects.toThrow("Папка «Книги» недоступна — выбери её снова");
	});

	it("record(id) читает сохранённую запись", async () => {
		const { lib, rec } = await opened();
		expect((await lib.record(rec.id))?.id).toBe(rec.id);
		expect(await lib.record("нет")).toBeNull();
	});
});

describe("folderStateOf", () => {
	const h = (q?: PermissionState) =>
		({ name: "x", ...(q ? { queryPermission: async () => q } : {}) }) as unknown as FileSystemDirectoryHandle;
	it("состояния", async () => {
		expect(await folderStateOf(h("granted"), false)).toBe("unsupported");
		expect(await folderStateOf(null, true)).toBe("none");
		expect(await folderStateOf(h(), true)).toBe("granted");
		expect(await folderStateOf(h("granted"), true)).toBe("granted");
		expect(await folderStateOf(h("prompt"), true)).toBe("needs-permission");
		expect(await folderStateOf(h("denied"), true)).toBe("needs-permission");
		const broken = { name: "x", queryPermission: () => Promise.reject(new Error("отказ")) } as unknown as FileSystemDirectoryHandle;
		expect(await folderStateOf(broken, true)).toBe("needs-permission");
	});
});

describe("FolderLibrary: рисунки и устаревший кэш", () => {
	const fb2 = () => {
		const fs = createMemFs();
		fs.put("Рис.fb2", utf8(fb2WithImages()));
		const cache = memCache();
		return { fs, cache, lib: new FolderLibrary(asDirHandle(fs), cache) };
	};
	/** Подкладывает запись кэша так, будто она сделана до рисунков. */
	const makeStale = (cache: ReturnType<typeof memCache>, id: string) => {
		const t = cache.m.get(id) as CachedText;
		cache.m.set(id, { paragraphs: t.paragraphs, toc: t.toc, images: [], v: 1 });
	};

	it("свежее открытие FB2: в кэше v2 и рисунки, второе открытие не разбирает заново", async () => {
		const { cache, lib } = fb2();
		const first = await lib.open("f:Рис.fb2");
		expect(first.images.length).toBeGreaterThan(0);
		const id = first.record.id;
		expect(cache.m.get(id)?.v).toBe(2);
		expect(cache.m.get(id)?.images.length).toBe(first.images.length);
		expect(cache.puts).toBe(1);
		const second = await lib.open(id);
		expect(second.images.length).toBe(first.images.length);
		expect(cache.puts).toBe(1);
	});

	it("кэш v1 без рисунков: после open рисунки есть, место не тронуто", async () => {
		const { cache, lib } = fb2();
		const first = await lib.open("f:Рис.fb2");
		const id = first.record.id;
		const position = { ...first.record.position, word: 4, para: 1 };
		await lib.save({ ...first.record, position, updatedAt: first.record.updatedAt + 10 });
		makeStale(cache, id);
		const again = await lib.open(id);
		expect(again.images.length).toBe(first.images.length);
		expect(again.record.position.word).toBe(4);
		expect(again.paragraphs).toEqual(first.paragraphs);
		expect(cache.m.get(id)?.v).toBe(2);
		expect((await lib.record(id))?.position.word).toBe(4);
	});

	it("кэш v1 и файл удалён: open не бросает, абзацы старые, рисунков нет", async () => {
		const { fs, cache, lib } = fb2();
		const first = await lib.open("f:Рис.fb2");
		makeStale(cache, first.record.id);
		fs.files.delete("Рис.fb2");
		const again = await lib.open(first.record.id);
		expect(again.paragraphs).toEqual(first.paragraphs);
		expect(again.images).toEqual([]);
	});

	it("TXT с кэшем v1: заново не разбирается", async () => {
		const cache = memCache();
		const fs = createMemFs();
		fs.put("Альфа.txt", BOOK(1));
		const own = new FolderLibrary(asDirHandle(fs), cache);
		const first = await own.open("f:Альфа.txt");
		const t = cache.m.get(first.record.id) as CachedText;
		cache.m.set(first.record.id, { ...t, v: 1 });
		const puts = cache.puts;
		await own.open(first.record.id);
		await own.open("f:Альфа.txt");
		expect(cache.puts).toBe(puts);
	});

	it("открытие по пути f: с устаревшим кэшем: рисунки есть", async () => {
		const { cache, lib } = fb2();
		const first = await lib.open("f:Рис.fb2");
		makeStale(cache, first.record.id);
		const again = await lib.open("f:Рис.fb2");
		expect(again.images.length).toBe(first.images.length);
		expect(again.record.id).toBe(first.record.id);
	});
});
