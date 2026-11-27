import { describe, expect, it } from "vitest";
import { bookMime } from "./original";

describe("bookMime", () => {
	it("определяет тип по расширению, если браузер его не дал", () => {
		expect(bookMime("a.fb2", "")).toBe("application/x-fictionbook+xml");
		expect(bookMime("A.FB2.ZIP", "")).toBe("application/zip");
		expect(bookMime("b.epub", "application/octet-stream")).toBe("application/epub+zip");
		expect(bookMime("d.txt", "")).toBe("text/plain");
		expect(bookMime("e.mobi", "")).toBe("application/octet-stream");
	});
	it("тип от браузера важнее расширения", () => {
		expect(bookMime("c.pdf", "application/pdf")).toBe("application/pdf");
		expect(bookMime("x.fb2", "text/xml")).toBe("text/xml");
	});
});
