// Временная заглушка экрана книги: Задача 6 заменяет её настоящим читателем и удаляет этот файл
import { currentLibrary } from "../library";
import type { Mode } from "../types";
import { h } from "./dom";
import { withProgress } from "./progress";

export interface StubCtx {
	goLibrary(): void;
}

export async function openBookStub(root: HTMLElement, key: string, urlMode: Mode | null, ctx: StubCtx): Promise<() => void> {
	const busy = h("div.busy", { "aria-live": "polite" });
	const body = h("div.book-stub");
	root.replaceChildren(h("div.library", {}, h("button.secondary", { type: "button", onclick: () => ctx.goLibrary() }, "К библиотеке"), busy, body));
	const { lib } = await currentLibrary();
	try {
		const book = await withProgress(busy, key.replace(/^f:/, ""), (p) => lib.open(key, p));
		busy.textContent = "";
		const mode = urlMode ?? book.record.position.mode;
		if (key.startsWith("f:")) history.replaceState(null, "", `#/read/${encodeURIComponent(book.record.id)}/${mode}`);
		body.append(
			h("h2", {}, book.record.title),
			h("p", {}, book.record.author || "Автор неизвестен"),
			h("p", {}, `Режим: ${mode}`),
			h("p", {}, `Слово: ${book.record.position.word}`),
		);
	} catch (e) {
		busy.textContent = `Не получилось открыть: ${e instanceof Error ? e.message : "ошибка"}`;
	}
	return () => {};
}
