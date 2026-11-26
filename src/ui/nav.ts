// Оглавление, закладки и ползунок места — общие для всех режимов, всё в словах
import { snippetAt } from "../core/anchor";
import type { WordStream } from "../core/words";
import type { Bookmark, TocEntry } from "../types";
import { h, iconButton, openSheet } from "./dom";

export interface ChapterMark {
	title: string;
	level: number;
	word: number;
}

/** Пункты оглавления, переведённые из абзацев в слова. */
export function buildChapters(stream: WordStream, toc: TocEntry[]): ChapterMark[] {
	return toc
		.filter((t) => t.paragraph >= 0 && t.paragraph < stream.paraStarts.length)
		.map((t) => ({ title: t.title, level: t.level, word: stream.paraStarts[t.paragraph] }));
}

/** Глава, в которой лежит слово; sorted — главы по возрастанию слова. */
export function chapterAt(sorted: ChapterMark[], word: number): ChapterMark | null {
	let found: ChapterMark | null = null;
	for (const c of sorted) {
		if (c.word <= word) found = c;
		else break;
	}
	return found;
}

/**
 * Проценты (0–100) начал глав для засечек на линии места и ползунке.
 * Берётся наименьший уровень оглавления; если таких глав меньше двух — все уровни.
 * Без нуля и без повторов ближе 0.2%; больше max — равномерно прореживаем.
 */
export function chapterTicks(chapters: ChapterMark[], total: number, max = 150): number[] {
	if (chapters.length === 0 || total <= 1) return [];
	const top = Math.min(...chapters.map((c) => c.level));
	const topLevel = chapters.filter((c) => c.level === top);
	const used = topLevel.length >= 2 ? topLevel : chapters;
	const pcts = used.map((c) => (c.word / (total - 1)) * 100).sort((a, b) => a - b);
	const ticks: number[] = [];
	for (const p of pcts) {
		if (p <= 0 || p > 100) continue;
		if (ticks.length && p - ticks[ticks.length - 1] < 0.2) continue;
		ticks.push(p);
	}
	if (ticks.length <= max) return ticks;
	return Array.from({ length: max }, (_, i) => ticks[Math.floor((i * ticks.length) / max)]);
}

/** Слой засечек: i.tick с left в процентах; сам слой не ловит касания. */
export function tickLayer(ticks: number[], cls: string): HTMLElement {
	const layer = h(`div.${cls}` as "div", { "aria-hidden": "true" });
	for (const p of ticks) layer.append(h("i.tick", { style: `left:${p.toFixed(2)}%` }));
	return layer;
}

export interface NavCtx {
	stream: WordStream;
	chapters: ChapterMark[];
	bookmarks(): Bookmark[];
	word(): number;
	seek(word: number): void;
	removeBookmark(id: string): void;
	/** Все закладки-цитаты одним текстом в Markdown; вызывается прямо из касания кнопки */
	exportQuotes?(): void;
}

export function openNav(ctx: NavCtx): () => void {
	const n = ctx.stream.words.length;
	const pctOf = (w: number) => (n > 1 ? (w / (n - 1)) * 100 : 0);
	const snip = (w: number) => snippetAt(ctx.stream, w, 9);
	const sorted = [...ctx.chapters].sort((x, y) => x.word - y.word);
	const here = ctx.word();

	const posOut = h("output", {}, `${pctOf(here).toFixed(1)}%`);
	const pos = h("input", { type: "range", min: 0, max: 1000, step: 1, value: Math.round(pctOf(here) * 10), "aria-label": "Позиция в книге" });
	pos.addEventListener("input", () => {
		const w = Math.round((Number(pos.value) / 1000) * (n - 1));
		posOut.textContent = `${(Number(pos.value) / 10).toFixed(1)}% · ${snip(w).slice(0, 40)}…`;
	});
	pos.addEventListener("change", () => ctx.seek(Math.round((Number(pos.value) / 1000) * (n - 1))));

	const tocList = h("div.toc-list");
	const current = chapterAt(sorted, here);
	if (ctx.chapters.length === 0) tocList.append(h("p.empty", {}, "В этой книге нет оглавления. Двигайся ползунком выше"));
	for (const c of ctx.chapters) {
		const btn = h(
			"button.toc-item",
			{ type: "button", style: `padding-left:${12 + c.level * 16}px` },
			h("span", {}, c.title),
			h("small", {}, `${Math.round(pctOf(c.word))}%`),
		);
		if (c === current || (current && c.word === current.word && c.title === current.title)) btn.classList.add("current");
		btn.addEventListener("click", () => {
			ctx.seek(c.word);
			close();
		});
		tocList.append(btn);
	}

	const marks = h("div.marks-list");
	const tabMarks = h("button", { type: "button", role: "tab", "aria-selected": "false" });
	const renderMarks = () => {
		const list = ctx.bookmarks();
		tabMarks.textContent = `Закладки${list.length ? ` · ${list.length}` : ""}`;
		marks.replaceChildren();
		if (list.length === 0) {
			marks.append(h("p.empty", {}, "Закладок пока нет. Значок закладки сверху отмечает текущее место"));
			return;
		}
		if (ctx.exportQuotes && list.some((b) => b.quote)) {
			marks.append(h("button.export-quotes", { type: "button", onclick: () => ctx.exportQuotes?.() }, "Цитаты в Markdown"));
		}
		for (const b of list) {
			const ch = chapterAt(sorted, b.word);
			marks.append(
				h(
					"div.mark",
					{},
					h(
						"button.mark-go",
						{
							type: "button",
							onclick: () => {
								ctx.seek(b.word);
								close();
							},
						},
						b.quote ? h("span.mark-quote", {}, `«${b.quote}»`) : h("span", {}, `${b.snippet}…`),
						h("small", {}, `${Math.round(pctOf(b.word))}%${ch ? ` · ${ch.title}` : ""}`),
					),
					iconButton("trash", "Удалить закладку", () => {
						ctx.removeBookmark(b.id);
						renderMarks();
					}),
				),
			);
		}
	};
	renderMarks();

	const tabToc = h("button", { type: "button", role: "tab", "aria-selected": "true" }, "Оглавление");
	const panes = h("div.panes", {}, tocList, marks);
	marks.hidden = true;
	const select = (toc: boolean) => {
		tabToc.setAttribute("aria-selected", String(toc));
		tabMarks.setAttribute("aria-selected", String(!toc));
		tocList.hidden = !toc;
		marks.hidden = toc;
	};
	tabToc.addEventListener("click", () => select(true));
	tabMarks.addEventListener("click", () => select(false));

	const body = h("div.nav", {}, h("label.row.range-row", {}, h("span.row-label", {}, "Позиция", posOut), h("div.range-wrap", {}, tickLayer(chapterTicks(ctx.chapters, n), "range-ticks"), pos)), h("div.tabs", { role: "tablist" }, tabToc, tabMarks), panes);
	const close = openSheet("Навигация", body);
	requestAnimationFrame(() => tocList.querySelector(".current")?.scrollIntoView({ block: "center" }));
	return close;
}
