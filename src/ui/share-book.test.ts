import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseFor, fullPath, shareOrSave } from "./share-book";

describe("baseFor", () => {
	it("путь с верной последней папкой возвращается без слэша на конце", () => {
		expect(baseFor("D:\\Книги", "Книги")).toBe("D:\\Книги");
		expect(baseFor("D:\\Книги\\", "Книги")).toBe("D:\\Книги");
		expect(baseFor("D:/Книги/", "книги")).toBe("D:/Книги");
		expect(baseFor("  D:\\Книги  ", "Книги")).toBe("D:\\Книги");
	});
	it("чужая папка и пустая строка — null", () => {
		expect(baseFor("D:\\Другое", "Книги")).toBeNull();
		expect(baseFor("", "Книги")).toBeNull();
	});
});

describe("fullPath", () => {
	it("склеивает с путём внутри папки и меняет слэши на обратные", () => {
		expect(fullPath("D:\\Книги", "sub/a.fb2")).toBe("D:\\Книги\\sub\\a.fb2");
		expect(fullPath("D:\\Книги", "a.fb2")).toBe("D:\\Книги\\a.fb2");
	});
});

describe("shareOrSave", () => {
	const file = new File(["x"], "book.fb2", { type: "application/x-fictionbook+xml" });
	let clicked: string[];
	let share: ReturnType<typeof vi.fn>;
	let canShare: ReturnType<typeof vi.fn>;

	function setup(opts: { touch?: boolean; hasShare?: boolean } = {}): void {
		const touch = opts.touch ?? true;
		vi.stubGlobal("matchMedia", () => ({ matches: touch }));
		share = vi.fn(async () => undefined);
		canShare = vi.fn(() => true);
		Object.defineProperty(navigator, "share", { value: opts.hasShare === false ? undefined : share, configurable: true });
		Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });
		URL.createObjectURL = vi.fn(() => "blob:test");
		URL.revokeObjectURL = vi.fn();
	}

	beforeEach(() => {
		clicked = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			clicked.push(this.download);
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("касание и успешный share — shared, ссылка не кликалась", async () => {
		setup();
		expect(await shareOrSave(file, "Книга")).toBe("shared");
		expect(share).toHaveBeenCalledWith({ files: [file], title: "Книга" });
		expect(clicked).toEqual([]);
	});

	it("NotAllowedError — сохраняем скачиванием с именем файла", async () => {
		setup();
		share.mockRejectedValue(new DOMException("нет жеста", "NotAllowedError"));
		expect(await shareOrSave(file, "Книга")).toBe("saved");
		expect(clicked).toEqual(["book.fb2"]);
	});

	it("AbortError — cancelled без скачивания", async () => {
		setup();
		share.mockRejectedValue(new DOMException("закрыл", "AbortError"));
		expect(await shareOrSave(file, "Книга")).toBe("cancelled");
		expect(clicked).toEqual([]);
	});

	it("canShare false — saved без вызова share", async () => {
		setup();
		canShare.mockReturnValue(false);
		expect(await shareOrSave(file, "Книга")).toBe("saved");
		expect(share).not.toHaveBeenCalled();
		expect(clicked).toEqual(["book.fb2"]);
	});

	it("не касание — saved без вызова share", async () => {
		setup({ touch: false });
		expect(await shareOrSave(file, "Книга")).toBe("saved");
		expect(share).not.toHaveBeenCalled();
		expect(clicked).toEqual(["book.fb2"]);
	});
});
