// Экран книги: верхняя панель, переключатель режимов, место в книге, закладки, настройки, сохранение
import { makePosition, resolvePosition, snippetAt } from "../core/anchor";
import { buildWords, type WordStream } from "../core/words";
import { currentLibrary } from "../library";
import type { Library } from "../library/types";
import type { Settings } from "../settings";
import type { Bookmark, Mode, OpenedBook } from "../types";
import { h, icon, iconButton, toast } from "./dom";
import { buildChapters, chapterAt, openNav } from "./nav";
import { type ModeFactory, type ModeHost, type ModeView } from "./modes/types";
import { pagesMode } from "./modes/pages";
import { typingMode } from "./modes/typing";
import { wordsMode } from "./modes/words";
import { withProgress } from "./progress";
import { openSettings } from "./settings-sheet";

export interface BookCtx {
	settings: Settings;
	saveSettings(): void;
	goLibrary(): void;
	/** Маршрут ещё актуален: пользователь не ушёл с экрана, пока книга открывалась. */
	alive(): boolean;
}

/** Все режимы — в одном месте: задачи 7 и 8 меняют только свои файлы в modes/. */
const FACTORIES: Record<Mode, ModeFactory> = { pages: pagesMode, words: wordsMode, typing: typingMode };
const MODES: { mode: Mode; label: string; ico: string }[] = [
	{ mode: "pages", label: "Страницы", ico: "book" },
	{ mode: "words", label: "По слову", ico: "play" },
	{ mode: "typing", label: "Печать", ico: "keyboard" },
];

/** Запись на диск не чаще раза в это время, пока читают. */
const SAVE_EVERY_MS = 3000;
const SAVE_ERROR_TOAST_MS = 60000;

function newId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

export async function openBook(root: HTMLElement, key: string, urlMode: Mode | null, ctx: BookCtx): Promise<() => void> {
	let disposed = false;
	const noop = () => {
		disposed = true;
	};

	// ---- открытие: строка прогресса и сторож зависания
	const busy = h("div.busy", { "aria-live": "polite" });
	const loading = h("div.book.loading", {}, h("button.secondary", { type: "button", onclick: () => ctx.goLibrary() }, "К библиотеке"), busy);
	root.replaceChildren(loading);

	const { lib } = await currentLibrary();
	if (disposed || !ctx.alive()) return noop;
	let opened: OpenedBook;
	try {
		opened = await withProgress(busy, key.replace(/^f:/, ""), (p) => lib.open(key, p));
	} catch (e) {
		if (!disposed && ctx.alive()) busy.textContent = `Не получилось открыть: ${e instanceof Error ? e.message : "ошибка"}`;
		return noop;
	}
	if (disposed || !ctx.alive()) return noop;

	const stream: WordStream = buildWords(opened.paragraphs);
	const total = stream.words.length;
	if (total === 0) {
		busy.textContent = "В книге не нашлось текста";
		return noop;
	}
	return mountBook(root, lib, opened, stream, urlMode, ctx, () => disposed, (v) => (disposed = v));
}

function mountBook(
	root: HTMLElement,
	lib: Library,
	opened: OpenedBook,
	stream: WordStream,
	urlMode: Mode | null,
	ctx: BookCtx,
	isDisposed: () => boolean,
	setDisposed: (v: boolean) => void,
): () => void {
	const record = opened.record;
	const total = stream.words.length;
	const settings = ctx.settings;
	const chapters = buildChapters(stream, opened.toc);
	const sorted = [...chapters].sort((x, y) => x.word - y.word);
	let mode: Mode = urlMode ?? record.position.mode;
	let view: ModeView | null = null;
	let switching = false;

	// ---- сохранение: только изменения, не чаще раза в SAVE_EVERY_MS
	let dirty = record.wordCount !== total;
	let changedAt = Date.now();
	let lastSave = 0;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> = Promise.resolve();
	let lastErrorToast = 0;

	function touch(): void {
		dirty = true;
		changedAt = Date.now();
	}

	function flush(): void {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (!dirty) return;
		dirty = false;
		lastSave = Date.now();
		record.wordCount = total;
		record.updatedAt = changedAt;
		const snapshot = structuredClone(record);
		saving = saving
			.then(() => lib.save(snapshot))
			.catch((e) => {
				dirty = true;
				if (isDisposed()) return;
				const now = Date.now();
				if (now - lastErrorToast > SAVE_ERROR_TOAST_MS) {
					lastErrorToast = now;
					toast(`Не получилось сохранить место: ${e instanceof Error ? e.message : "ошибка"}`, 4000);
				}
			});
	}

	function scheduleSave(): void {
		if (saveTimer !== undefined || !dirty) return;
		const wait = Math.max(0, lastSave + SAVE_EVERY_MS - Date.now());
		if (wait === 0) flush();
		else saveTimer = setTimeout(flush, wait);
	}

	// ---- разметка
	const bar = h("div.progress-fill");
	const chapterLine = h("div.chapter");
	const titleLine = h("div.book-title", {}, record.title);
	const bookmarkBtn = iconButton("bookmark", "Закладка здесь", () => addBookmark());
	const switcher = h("nav.modes", { "aria-label": "Режим чтения" });
	const buttons = new Map<Mode, HTMLButtonElement>();
	for (const m of MODES) {
		const b = h("button.mode-btn", { type: "button", "aria-label": m.label, "data-m": m.mode }, icon(m.ico, 18), h("span", {}, m.label));
		b.addEventListener("click", () => void switchMode(m.mode));
		buttons.set(m.mode, b);
		switcher.append(b);
	}
	const body = h("div.book-body");
	const book = h(
		"div.book",
		{ "data-mode": mode, "data-word": record.position.word },
		h("div.progress", { "aria-hidden": "true" }, bar),
		h(
			"header.topbar",
			{},
			iconButton("back", "К библиотеке", () => ctx.goLibrary()),
			h("div.where", {}, chapterLine, titleLine),
			iconButton("toc", "Оглавление и закладки", () => openNavSheet()),
			bookmarkBtn,
			iconButton("gear", "Настройки", () => openSettingsSheet()),
		),
		switcher,
		body,
	);
	root.replaceChildren(book);

	function showMode(): void {
		book.dataset.mode = mode;
		for (const [m, b] of buttons) b.setAttribute("aria-pressed", String(m === mode));
	}

	function showWord(word: number): void {
		book.dataset.word = String(word);
		const pct = total > 1 ? (word / (total - 1)) * 100 : 0;
		bar.style.width = `${pct}%`;
		const ch = chapterAt(sorted, word);
		const text = ch ? ch.title : "";
		if (chapterLine.textContent !== text) chapterLine.textContent = text;
		book.classList.toggle("no-chapter", !ch);
	}

	// ---- интерфейс для режимов
	function report(word: number): void {
		if (isDisposed()) return;
		const w = Math.min(Math.max(0, word), total - 1);
		showWord(w);
		if (w !== record.position.word || mode !== record.position.mode) {
			record.position = makePosition(stream, w, mode);
			dirty = true;
			changedAt = record.position.at;
			scheduleSave();
		}
	}

	function addBookmark(): void {
		if (isDisposed()) return;
		const word = view ? view.word() : record.position.word;
		const b: Bookmark = { id: newId(), word, createdAt: Date.now(), snippet: snippetAt(stream, word, 9) };
		record.bookmarks = [...record.bookmarks, b].sort((x, y) => x.word - y.word);
		touch();
		flush();
		bookmarkBtn.classList.add("flash");
		setTimeout(() => bookmarkBtn.classList.remove("flash"), 600);
		toast("Закладка добавлена");
	}

	function removeBookmark(id: string): void {
		record.bookmarks = record.bookmarks.filter((x) => x.id !== id);
		touch();
		flush();
	}

	function openNavSheet(): void {
		if (isDisposed()) return;
		view?.pause();
		openNav({
			stream,
			chapters,
			bookmarks: () => record.bookmarks,
			word: () => (view ? view.word() : record.position.word),
			seek: (w) => view?.seek(w),
			removeBookmark,
		});
	}

	function openSettingsSheet(): void {
		if (isDisposed()) return;
		view?.pause();
		openSettings(settings, () => ctx.saveSettings(), view?.settingsRows() ?? []);
	}

	const host: ModeHost = {
		book: opened,
		stream,
		settings,
		saveSettings: () => ctx.saveSettings(),
		report,
		flush,
		addBookmark,
		openNav: openNavSheet,
		goLibrary: () => ctx.goLibrary(),
		updateTyping(t) {
			record.typing = t;
			touch();
			scheduleSave();
		},
	};

	function setUrl(): void {
		const url = `#/read/${encodeURIComponent(record.id)}/${mode}`;
		if (location.hash !== url) history.replaceState(null, "", url);
	}

	async function startMode(next: Mode, word: number): Promise<void> {
		const created = await FACTORIES[next](host, word);
		if (isDisposed()) {
			created.destroy();
			return;
		}
		view = created;
		body.replaceChildren(created.root);
	}

	async function switchMode(next: Mode): Promise<void> {
		if (isDisposed() || switching || next === mode) return;
		switching = true;
		const prev = mode;
		try {
			const word = view ? view.word() : record.position.word;
			view?.pause();
			flush();
			view?.destroy();
			view = null;
			body.replaceChildren();
			mode = next;
			showMode();
			setUrl();
			record.position = makePosition(stream, word, mode);
			touch();
			changedAt = record.position.at;
			flush();
			try {
				await startMode(next, word);
			} catch (e) {
				console.error(e);
				if (isDisposed()) return;
				toast("Не получилось открыть этот режим");
				mode = prev;
				showMode();
				setUrl();
				await startMode(prev, word);
			}
		} finally {
			switching = false;
		}
	}

	// ---- клавиши оболочки; в печати Escape и буквы принадлежат режиму
	const onKey = (e: KeyboardEvent) => {
		if (isDisposed() || mode === "typing") return;
		if (document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === "Escape") ctx.goLibrary();
		else if (e.key === "b" || e.key === "и") addBookmark();
	};
	const onHide = () => {
		if (document.visibilityState === "hidden") flush();
	};
	document.addEventListener("keydown", onKey);
	document.addEventListener("visibilitychange", onHide);
	window.addEventListener("pagehide", flush);

	// ---- запуск
	const start = resolvePosition(stream, record.position, record.wordCount);
	showMode();
	showWord(start);
	setUrl();
	scheduleSave();
	startMode(mode, start).catch((e) => {
		console.error(e);
		if (!isDisposed()) toast("Не получилось открыть режим", 4000);
	});

	return () => {
		if (isDisposed()) return;
		flush();
		setDisposed(true);
		clearTimeout(saveTimer);
		view?.destroy();
		view = null;
		document.removeEventListener("keydown", onKey);
		document.removeEventListener("visibilitychange", onHide);
		window.removeEventListener("pagehide", flush);
	};
}
