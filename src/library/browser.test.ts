import { describe, expect, it, vi } from "vitest";
import { fb2WithCaptions, fb2WithImages } from "../parsers/test-fixtures";
import type { BookImage, BookRecord, TocEntry } from "../types";

// IndexedDB в jsdom нет: подменяем слой db простой памятью, put с рисунками бросает
const store = vi.hoisted(() => ({
	books: new Map<string, unknown>(),
	texts: new Map<string, { paragraphs: string[]; toc: unknown[]; images: unknown[]; v: number }>(),
	calls: [] as number[],
	files: new Map<string, File>(),
	failFile: false,
}));

vi.mock("./db", () => ({
	db: async () => ({
		get: async (_s: string, k: string) => store.books.get(k),
		getAll: async () => [...store.books.values()],
		put: async (_s: string, v: BookRecord) => void store.books.set(v.id, v),
		transaction: () => ({
			store: { get: async (k: string) => store.books.get(k), put: async (v: BookRecord) => void store.books.set(v.id, v) },
			objectStore: (name: string) => ({
				delete: async (k: string) => {
					if (name === "books") store.books.delete(k);
					else if (name === "texts") store.texts.delete(k);
					else store.files.delete(k);
				},
			}),
			done: Promise.resolve(),
		}),
	}),
	putFile: async (id: string, file: File) => {
		if (store.failFile) throw new DOMException("quota", "QuotaExceededError");
		store.files.set(id, file);
	},
	getFile: async (id: string) => store.files.get(id) ?? null,
	hasFile: async (id: string) => store.files.has(id),
	getText: async (id: string) => store.texts.get(id) ?? null,
	putText: async (id: string, paragraphs: string[], toc: TocEntry[], images: BookImage[]) => {
		store.calls.push(images.length);
		if (images.length) throw new DOMException("quota", "QuotaExceededError");
		store.texts.set(id, { paragraphs, toc, images, v: 2 });
	},
}));

import { BrowserLibrary } from "./browser";

describe("BrowserLibrary: кэш не принимает рисунки", () => {
	it("книга добавляется, текст в кэше, рисунков в кэше нет", async () => {
		const lib = new BrowserLibrary();
		const file = new File([fb2WithImages()], "ris.fb2");
		const [id] = await lib.addFiles([file]);
		expect(store.calls[0]).toBeGreaterThan(0);
		expect(store.calls[1]).toBe(0);
		const cached = store.texts.get(id);
		expect(cached?.paragraphs.length).toBeGreaterThan(0);
		expect(cached?.images).toEqual([]);
		expect(await lib.record(id)).not.toBeNull();
		// текущий сеанс рисунки видит
		const opened = await lib.open(id);
		expect(opened.images.length).toBeGreaterThan(0);
		expect(opened.paragraphs).toEqual(cached?.paragraphs);
	});
});

describe("BrowserLibrary: исходный файл", () => {
	const make = () => new File([fb2WithCaptions()], "podpisi.fb2");

	it("кладёт исходный файл новой книги", async () => {
		const lib = new BrowserLibrary();
		const f = make();
		const [key] = await lib.addFiles([f]);
		const orig = await lib.original(key);
		expect(orig?.name).toBe(f.name);
		expect(orig?.size).toBe(f.size);
		await lib.remove(key);
	});

	it("место кончилось на файле — книга добавлена без файла", async () => {
		const lib = new BrowserLibrary();
		store.failFile = true;
		try {
			const [key] = await lib.addFiles([make()]);
			expect(await lib.record(key)).not.toBeNull();
			expect(await lib.original(key)).toBeNull();
			await lib.remove(key);
		} finally {
			store.failFile = false;
		}
	});

	it("повторное добавление книги без файла кладёт файл и не трогает запись", async () => {
		const lib = new BrowserLibrary();
		store.failFile = true;
		const [key] = await lib.addFiles([make()]);
		store.failFile = false;
		const rec = (await lib.record(key)) as BookRecord;
		const changed: BookRecord = { ...rec, position: { ...rec.position, word: 7 }, bookmarks: [{ id: "b1", word: 3, snippet: "закладка", createdAt: 1 }], updatedAt: rec.updatedAt + 1000 };
		await lib.save(changed);
		const before = await lib.record(key);
		await lib.addFiles([make()]);
		expect(await lib.record(key)).toEqual(before);
		expect((await lib.record(key))?.position.word).toBe(7);
		expect((await lib.record(key))?.bookmarks.map((b) => b.id)).toEqual(["b1"]);
		expect((await lib.original(key))?.name).toBe("podpisi.fb2");
		await lib.remove(key);
	});

	it("удаление книги удаляет и файл", async () => {
		const lib = new BrowserLibrary();
		const [key] = await lib.addFiles([make()]);
		expect(await lib.original(key)).not.toBeNull();
		await lib.remove(key);
		expect(await lib.original(key)).toBeNull();
		expect(await lib.record(key)).toBeNull();
	});
});
