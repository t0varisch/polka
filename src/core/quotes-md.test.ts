import { describe, expect, it } from "vitest";
import { quotesMarkdown } from "./quotes-md";

describe("quotesMarkdown", () => {
	it("книга с автором и двумя цитатами — точный текст", () => {
		const md = quotesMarkdown("Название", "Автор", [
			{ quote: "текст цитаты", chapter: "Глава", page: 12, pct: 5 },
			{ quote: "следующая цитата", chapter: null, page: null, pct: 34 },
		]);
		expect(md).toBe("# Название\n\nАвтор\n\n> текст цитаты\n\n— Глава, стр. 12\n\n> следующая цитата\n\n— 34%\n");
	});
	it("пустой автор — нет строки автора и лишних пустых строк", () => {
		const md = quotesMarkdown("Название", "  ", [{ quote: "q", chapter: null, page: 3, pct: 1 }]);
		expect(md).toBe("# Название\n\n> q\n\n— стр. 3\n");
	});
	it("глава без страницы — процент после главы", () => {
		const md = quotesMarkdown("Н", "А", [{ quote: "q", chapter: "Глава", page: null, pct: 34 }]);
		expect(md).toContain("— Глава, 34%\n");
	});
	it("многострочная цитата — каждая строка с «> »", () => {
		const md = quotesMarkdown("Н", "", [{ quote: "a\nb", chapter: null, page: null, pct: 0 }]);
		expect(md).toBe("# Н\n\n> a\n> b\n\n— 0%\n");
	});
});
