import { describe, expect, it } from "vitest";
import { type TextCache, FolderLibrary, PROGRESS_FILE, SERVICE_DIR } from "./folder";
import { folderStateOf } from "./index";
import { type MemDirHandle, asDirHandle, createMemFs } from "./memfs";
import { parseProgress } from "./record";

const BOOK = (n: number) => `Книга номер ${n}\n\nПервый абзац книги ${n} со словами для счёта.\n\nВторой абзац книги ${n} тоже со словами.`;

function memCache(): TextCache {
	const m = new Map<string, { paragraphs: string[]; toc: never[] }>();
	return {
		get: async (id) => m.get(id) ?? null,
		put: async (id, paragraphs) => void m.set(id, { paragraphs, toc: [] }),
	};
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

const progress = (fs: MemDirHandle) => parseProgress(fs.text(`${SERVICE_DIR}/${PROGRESS_FILE}`) ?? "");

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
		fs.rename("Бета.txt", "Новая.txt");
		const items = await lib.list();
		expect(items.find((i) => i.fileName === "Новая.txt")?.record).toBeNull();
		expect(items.some((i) => i.record)).toBe(false);
		const reopened = await lib.open("f:Новая.txt");
		expect(reopened.record.id).toBe(record.id);
		expect(progress(fs).books[record.id].file).toBe("Новая.txt");
		expect(Object.keys(progress(fs).books).length).toBe(1);
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
	});
});
