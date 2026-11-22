import { describe, expect, it, vi } from "vitest";
import { fb2WithImages } from "../parsers/test-fixtures";
import type { BookImage, BookRecord, TocEntry } from "../types";

// IndexedDB в jsdom нет: подменяем слой db простой памятью, put с рисунками бросает
const store = vi.hoisted(() => ({
	books: new Map<string, unknown>(),
	texts: new Map<string, { paragraphs: string[]; toc: unknown[]; images: unknown[]; v: number }>(),
	calls: [] as number[],
}));

vi.mock("./db", () => ({
	db: async () => ({
		get: async (_s: string, k: string) => store.books.get(k),
		getAll: async () => [...store.books.values()],
		put: async (_s: string, v: BookRecord) => void store.books.set(v.id, v),
		transaction: () => ({
			store: { get: async (k: string) => store.books.get(k), put: async (v: BookRecord) => void store.books.set(v.id, v) },
			done: Promise.resolve(),
		}),
	}),
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
