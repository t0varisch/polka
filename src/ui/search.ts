// Лист «Поиск»: запрос, список совпадений по всей книге, переход на слово
import { findInBook, type SearchMatch } from "../core/search";
import type { WordStream } from "../core/words";
import { h, icon, openSheet } from "./dom";
import { chapterAt, type ChapterMark } from "./nav";

/** Что помнит поиск, пока книга открыта: прежний запрос, список и последнее выбранное совпадение. */
export interface SearchMemo {
	query: string;
	matches: SearchMatch[];
	more: boolean;
	/** Индекс выбранного в списке совпадения, -1 — ничего. */
	picked: number;
}

export function newSearchMemo(): SearchMemo {
	return { query: "", matches: [], more: false, picked: -1 };
}

export interface SearchCtx {
	paragraphs: string[];
	stream: WordStream;
	/** Главы по возрастанию слова. */
	sorted: ChapterMark[];
	memo: SearchMemo;
	/** Тот же переход, что у оглавления: место сохраняется режимом. */
	seek(word: number): void;
	onClose(): void;
}

export interface SearchSheet {
	close(): void;
	/** Вернуть фокус в поле и выделить запрос (Ctrl+F при уже открытом листе). */
	focus(): void;
}

const LIMIT = 300;
const DEBOUNCE_MS = 250;
const BEFORE = 40;
const AFTER = 60;

export function openSearch(ctx: SearchCtx): SearchSheet {
	const { memo, stream } = ctx;
	const n = stream.words.length;
	const pctOf = (w: number) => (n > 1 ? Math.round((w / (n - 1)) * 100) : 0);

	const input = h("input", {
		type: "search",
		"aria-label": "Запрос",
		placeholder: "Что искать",
		enterkeyhint: "search",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		value: memo.query,
	});
	const status = h("p.search-status", { role: "status" });
	const list = h("div.search-list");
	const body = h("div.search", {}, h("div.search-field", {}, icon("search", 20), input), status, list);

	// кусок текста: ~40 символов до совпадения и ~60 после, совпадение в <mark>; книгу не размечаем
	function snippet(m: SearchMatch): HTMLElement {
		const p = ctx.paragraphs[m.para];
		const from = Math.max(0, m.offset - BEFORE);
		const to = Math.min(p.length, m.offset + m.length + AFTER);
		const flat = (s: string) => s.replace(/\s+/g, " ");
		return h(
			"span.search-text",
			{},
			from > 0 ? "…" : "",
			flat(p.slice(from, m.offset)),
			h("mark", {}, flat(p.slice(m.offset, m.offset + m.length))),
			flat(p.slice(m.offset + m.length, to)),
			to < p.length ? "…" : "",
		);
	}

	function render(): void {
		const q = memo.query.trim();
		if (!q) status.textContent = "";
		else if (memo.matches.length === 0) status.textContent = q.length < 2 ? "Нужно хотя бы два символа" : "Ничего не нашлось";
		else status.textContent = memo.more ? `Найдено больше ${LIMIT}, показаны первые ${LIMIT}` : `Найдено: ${memo.matches.length}`;
		list.replaceChildren();
		memo.matches.forEach((m, i) => {
			const ch = chapterAt(ctx.sorted, m.word);
			const item = h(
				"button.search-item",
				{ type: "button", "data-word": m.word },
				snippet(m),
				h("small", {}, `${ch ? `${ch.title} · ` : ""}${pctOf(m.word)}%`),
			);
			if (i === memo.picked) item.classList.add("picked");
			item.addEventListener("click", () => {
				// нажали на старый список, пока новый запрос ждал паузы: остаётся запрос, которому список принадлежит
				clearTimeout(timer);
				input.value = memo.query;
				memo.picked = i;
				ctx.seek(m.word);
				close();
			});
			list.append(item);
		});
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	function run(): void {
		clearTimeout(timer);
		const q = input.value;
		if (q === memo.query) return;
		memo.query = q;
		memo.picked = -1;
		const r = findInBook(ctx.paragraphs, stream, q, LIMIT);
		memo.matches = r.matches;
		memo.more = r.more;
		render();
	}
	input.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(run, DEBOUNCE_MS);
	});
	input.addEventListener("keydown", (e) => {
		if (e.key !== "Enter") return;
		e.preventDefault();
		run();
	});

	const close = openSheet("Поиск", body, () => {
		// запрос, который не успели запустить, досчитываем: при повторном открытии поле и список согласованы
		run();
		ctx.onClose();
	});
	render();
	const focus = () => {
		input.focus();
		input.select();
	};
	requestAnimationFrame(() => {
		focus();
		list.querySelector(".picked")?.scrollIntoView({ block: "center" });
	});
	return { close, focus };
}
