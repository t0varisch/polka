// Экран книги: верхняя панель, переключатель режимов, место в книге, закладки, настройки, сохранение
import { makePosition, snippetAt } from "../core/anchor";
import { quotesMarkdown, type QuoteItem } from "../core/quotes-md";
import { sendText } from "./send-text";
import { buildWords, type WordStream } from "../core/words";
import { currentLibrary, regrantFolder } from "../library";
import type { Library } from "../library/types";
import type { Settings } from "../settings";
import type { Bookmark, BookRecord, Mode, OpenedBook } from "../types";
import { backLabel, createBackChip } from "./back-chip";
import { h, icon, iconButton, toast } from "./dom";
import { buildChapters, chapterAt, chapterTicks, openNav, tickLayer } from "./nav";
import { type ModeFactory, type ModeHost, type ModeView } from "./modes/types";
import { pagesMode } from "./modes/pages";
import { typingMode } from "./modes/typing";
import { wordsMode } from "./modes/words";
import { withProgress } from "./progress";
import { resumeAt, stampUpdated, syncDecision } from "./resume";
import { newSearchMemo, openSearch, type SearchSheet } from "./search";
import { openSettings } from "./settings-sheet";
import { openShareSheet } from "./share-book";

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
	let teardown: (() => void) | null = null;
	const dispose = () => {
		// сначала снимаем экран книги (он сам сохраняет место), потом закрываем маршрут
		teardown?.();
		disposed = true;
	};
	const gone = () => disposed || !ctx.alive();

	// ---- открытие: строка прогресса и сторож зависания
	async function begin(): Promise<void> {
		const busy = h("div.busy", { "aria-live": "polite" });
		const back = h("button.secondary", { type: "button", onclick: () => ctx.goLibrary() }, "К библиотеке");
		root.replaceChildren(h("div.book.loading", {}, back, busy));

		const { lib, folder, folderName } = await currentLibrary();
		if (gone()) return;
		// после перезапуска браузера доступ к папке нужно выдать заново, и только из нажатия
		if (folder === "needs-permission") {
			const again = h("button.primary", { type: "button" }, icon("folder", 20), `Открыть папку «${folderName ?? ""}»`);
			again.addEventListener("click", async () => {
				try {
					if (!(await regrantFolder())) return toast("Доступ к папке не выдан");
				} catch (e) {
					return toast(e instanceof Error && /[а-яё]/i.test(e.message) ? e.message : "Не получилось открыть папку");
				}
				if (!gone()) await begin();
			});
			busy.textContent = `Книга лежит в папке «${folderName ?? ""}», а доступ к ней нужно выдать заново`;
			busy.after(again);
			return;
		}
		let opened: OpenedBook;
		try {
			opened = await withProgress(busy, key.replace(/^f:/, ""), (p) => lib.open(key, p));
		} catch (e) {
			if (!gone()) busy.textContent = `Не получилось открыть: ${e instanceof Error ? e.message : "ошибка"}`;
			return;
		}
		if (gone()) return;

		const stream: WordStream = buildWords(opened.paragraphs);
		if (stream.words.length === 0) {
			busy.textContent = "В книге не нашлось текста";
			return;
		}
		teardown = mountBook(root, lib, opened, stream, urlMode, ctx, () => disposed, (v) => (disposed = v), folderName ?? null);
	}

	await begin();
	return dispose;
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
	folderName: string | null,
): () => void {
	const record = opened.record;
	const total = stream.words.length;
	const settings = ctx.settings;
	const chapters = buildChapters(stream, opened.toc);
	const sorted = [...chapters].sort((x, y) => x.word - y.word);
	let mode: Mode = urlMode ?? record.position.mode;
	let view: ModeView | null = null;
	let switching = false;
	/** Идёт запуск режима (в том числе первый): кнопки режимов не работают. */
	let starting = false;
	let startSeq = 0;
	/** Режим, который нажали во время запуска: включается, когда запуск закончится. */
	let pendingMode: Mode | null = null;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	const sheetClosers: (() => void)[] = [];
	const searchMemo = newSearchMemo();
	let search: SearchSheet | null = null;

	// ---- сохранение: только изменения, не чаще раза в SAVE_EVERY_MS
	// число слов в книге изменилось: возвращаемся по обрывку текста и сразу записываем найденное место
	const resume = resumeAt(stream, record, mode);
	let dirty = resume.changed;
	if (resume.changed) {
		record.position = resume.position;
		record.bookmarks = resume.bookmarks;
	}
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
		record.updatedAt = stampUpdated(changedAt, record.updatedAt);
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
		b.addEventListener("click", () => {
			void switchMode(m.mode);
			// иначе пробел потом «нажмёт» эту кнопку вместо перелистывания
			b.blur();
		});
		buttons.set(m.mode, b);
		switcher.append(b);
	}
	const body = h("div.book-body");
	const book = h(
		"div.book",
		{ "data-mode": mode, "data-word": record.position.word },
		h("div.progress", { "aria-hidden": "true" }, bar, tickLayer(chapterTicks(chapters, total), "ticks")),
		h(
			"header.topbar",
			{},
			iconButton("back", "К библиотеке", () => ctx.goLibrary()),
			h("div.where", {}, chapterLine, titleLine),
			iconButton("toc", "Оглавление и закладки", () => openNavSheet()),
			iconButton("search", "Поиск по книге", () => openSearchSheet()),
			bookmarkBtn,
			iconButton("gear", "Настройки", () => openSettingsSheet()),
		),
		switcher,
		body,
	);
	root.replaceChildren(book);
	// плашка живёт в экране книги, а не в режиме: режимы заменяются, плашка остаётся до смены режима
	const chip = createBackChip(book);

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
		if (isDisposed() || adopting) return;
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
		const sel = view?.selection?.() ?? null;
		const word = sel ? sel.from : view ? view.word() : record.position.word;
		const b: Bookmark = { id: newId(), word, createdAt: Date.now(), snippet: snippetAt(stream, word, 9) };
		if (sel) {
			b.end = sel.to;
			b.quote = sel.text;
			window.getSelection()?.removeAllRanges();
		}
		record.bookmarks = [...record.bookmarks, b].sort((x, y) => x.word - y.word);
		touch();
		flush();
		view?.marksChanged?.();
		bookmarkBtn.classList.add("flash");
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => bookmarkBtn.classList.remove("flash"), 600);
		toast(sel ? "Цитата в закладках" : "Закладка добавлена");
	}

	function removeBookmark(id: string): void {
		if (isDisposed()) return;
		record.bookmarks = record.bookmarks.filter((x) => x.id !== id);
		touch();
		flush();
		view?.marksChanged?.();
	}

	/** Прыжок из оглавления, закладки, ползунка, поиска: место запоминается, внизу плашка «Вернуться». */
	function jump(w: number): void {
		if (!view) return;
		const from = view.word();
		if (w === from) return view.seek(w);
		const label = (kind: "back" | "forward", at: number): string =>
			backLabel(kind, view?.pageOf?.(at) ?? null, total > 1 ? (at / (total - 1)) * 100 : 0);
		const text = label("back", from);
		view.seek(w);
		const go = (back: number): void => {
			if (!view) return;
			const to = view.word();
			const next = label("forward", to);
			view.seek(back);
			showChip(next, () => go(to));
		};
		showChip(text, () => go(from));
	}

	/** Плашка над органами управления режима: в «По слову» — над кнопками, в остальных — по CSS. */
	function showChip(label: string, onGo: () => void): void {
		chip.show(label, onGo);
		const el = book.querySelector<HTMLElement>(".back-chip");
		if (!el) return;
		const controls = body.querySelector<HTMLElement>(".mode-words .controls");
		el.style.bottom = controls ? `${Math.round(book.getBoundingClientRect().bottom - controls.getBoundingClientRect().top + 8)}px` : "";
	}

	/** Цитаты книги в Markdown; текст строится сразу, без await до share (жест для iPhone) */
	function exportQuotes(): void {
		const items: QuoteItem[] = record.bookmarks
			.filter((b) => b.quote)
			.map((b) => ({
				quote: b.quote ?? "",
				chapter: chapterAt(sorted, b.word)?.title ?? null,
				page: view?.pageOf?.(b.word) ?? null,
				pct: Math.round(total > 1 ? (b.word / (total - 1)) * 100 : 0),
			}));
		if (items.length === 0) return;
		const text = quotesMarkdown(record.title, record.author, items);
		void sendText(text, record.title).then((r) => {
			if (r === "copied") toast(`Скопировано цитат: ${items.length}`);
			else if (r === "failed") toast("Не удалось скопировать");
		});
	}

	function openNavSheet(): void {
		if (isDisposed()) return;
		view?.pause();
		sheetClosers.push(
			openNav({
			stream,
			chapters,
			bookmarks: () => record.bookmarks,
			word: () => (view ? view.word() : record.position.word),
			seek: jump,
			removeBookmark,
			exportQuotes,
		}),
		);
	}

	/** Поиск по всей книге; запрос и список помнятся, пока книга открыта. */
	function openSearchSheet(): void {
		if (isDisposed()) return;
		if (search) return search.focus();
		view?.pause();
		const sheet = openSearch({
			paragraphs: opened.paragraphs,
			stream,
			sorted,
			memo: searchMemo,
			seek: jump,
			onClose: () => (search = null),
		});
		search = sheet;
		sheetClosers.push(sheet.close);
	}

	function openSettingsSheet(): void {
		if (isDisposed()) return;
		view?.pause();
		// номера страниц могут смениться: подпись плашки устареет
		chip.hide();
		const top: HTMLElement[] = [];
		let closeSettings: (() => void) | null = null;
		if (record.format !== "text") {
			const share = h("button.share-row", { type: "button" }, icon("share", 20), h("span", {}, "Поделиться книгой"));
			share.addEventListener("click", () => {
				closeSettings?.();
				sheetClosers.push(
					openShareSheet({
						title: record.title,
						format: record.format,
						lib,
						key: record.id,
						rel: record.file ?? null,
						folderName,
						settings,
						saveSettings: () => ctx.saveSettings(),
						addFile: () => ctx.goLibrary(),
					}),
				);
			});
			top.push(share);
		}
		closeSettings = openSettings(settings, () => ctx.saveSettings(), view?.settingsRows() ?? [], undefined, top);
		sheetClosers.push(closeSettings);
	}

	const host: ModeHost = {
		book: opened,
		stream,
		settings,
		saveSettings: () => ctx.saveSettings(),
		report,
		flush: () => {
			if (!isDisposed()) flush();
		},
		addBookmark,
		bookmarks: () => record.bookmarks,
		openNav: openNavSheet,
		openSettings: openSettingsSheet,
		goLibrary: () => ctx.goLibrary(),
		updateTyping(t) {
			if (isDisposed() || adopting) return;
			record.typing = t;
			touch();
			scheduleSave();
		},
	};

	function setUrl(): void {
		const url = `#/read/${encodeURIComponent(record.id)}/${mode}`;
		if (location.hash !== url) history.replaceState(null, "", url);
	}

	/** Запуск режима с токеном: если за время ожидания фабрики запуск устарел или экран закрыт, готовый режим сразу уничтожается. */
	async function startMode(next: Mode, word: number): Promise<void> {
		const token = ++startSeq;
		starting = true;
		try {
			const created = await FACTORIES[next](host, word);
			if (isDisposed() || token !== startSeq) {
				created.destroy();
				return;
			}
			view = created;
			body.replaceChildren(created.root);
		} finally {
			if (token === startSeq) starting = false;
		}
	}

	function showFailure(e: unknown): void {
		const msg = e instanceof Error ? e.message : "ошибка";
		toast(`Не получилось открыть режим: ${msg}`, 4000);
		body.replaceChildren(h("div.mode-stub", {}, h("button.secondary", { type: "button", onclick: () => ctx.goLibrary() }, "К библиотеке")));
	}

	async function switchMode(next: Mode): Promise<void> {
		if (isDisposed()) return;
		if (starting || switching) {
			pendingMode = next;
			return;
		}
		if (next === mode) return;
		switching = true;
		const prev = mode;
		try {
			const word = view ? view.word() : record.position.word;
			view?.pause();
			chip.hide();
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
				mode = prev;
				showMode();
				setUrl();
				try {
					await startMode(prev, word);
				} catch (e2) {
					console.error(e2);
					if (!isDisposed()) showFailure(e2);
				}
			}
		} finally {
			switching = false;
			runPending();
		}
	}

	function runPending(): void {
		const next = pendingMode;
		pendingMode = null;
		if (next && next !== mode) void switchMode(next);
	}

	// ---- клавиши оболочки; в печати Escape и буквы принадлежат режиму
	const onKey = (e: KeyboardEvent) => {
		if (isDisposed() || mode === "typing") return;
		if (document.querySelector(".sheet-backdrop, .pg-viewer")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === "Escape") ctx.goLibrary();
		else if (e.key === "b" || e.key === "и") addBookmark();
	};
	// Ctrl+F, Cmd+F и F3 открывают наш поиск вместо браузерного (он видит только нарисованный кусок книги); в любом режиме.
	// Чужой лист или просмотр рисунка открыты — не трогаем. По коду клавиши: на русской раскладке key — «а»
	const onFind = (e: KeyboardEvent) => {
		if (isDisposed()) return;
		const find = e.key === "F3" || ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyF");
		if (!find) return;
		if (!search && document.querySelector(".sheet-backdrop.open, .pg-viewer")) return;
		e.preventDefault();
		e.stopPropagation();
		openSearchSheet();
	};
	// ---- вкладка вернулась на экран: место могли сдвинуть в другом окне
	let checking = false;
	/** Идёт подмена записи на чужую: режим не должен записывать своё поверх. */
	let adopting = false;
	async function checkStored(): Promise<void> {
		if (checking || isDisposed() || starting || switching || dirty) return;
		checking = true;
		try {
			await saving;
			const stored = await lib.record(record.id);
			if (isDisposed() || starting || switching) return;
			if (syncDecision(stored, { updatedAt: record.updatedAt, dirty }) !== "adopt" || !stored) return;
			const w = resumeAt(stream, stored, mode).start;
			switching = true;
			adopting = true;
			try {
				if (mode === "typing" && view) {
					// печать читает итоги при запуске: перезапускаем режим на чужих итогах
					view.pause();
					view.destroy();
					view = null;
					body.replaceChildren();
					adopt(stored);
					await startMode(mode, w);
				} else {
					adopt(stored);
					view?.seek(w);
				}
			} finally {
				adopting = false;
				switching = false;
				runPending();
			}
			showWord(w);
			toast("Место обновлено");
		} catch {
			// проверка необязательна: не вышло — остаёмся на своём месте
		} finally {
			checking = false;
		}
	}

	function adopt(stored: BookRecord): void {
		record.position = stored.position;
		record.bookmarks = stored.bookmarks;
		view?.marksChanged?.();
		record.typing = stored.typing;
		record.updatedAt = stored.updatedAt;
		record.openedAt = stored.openedAt;
		dirty = false;
		clearTimeout(saveTimer);
		saveTimer = undefined;
	}

	const onVisibility = () => {
		if (document.visibilityState === "hidden") flush();
		else void checkStored();
	};
	const onFocus = () => void checkStored();
	document.addEventListener("keydown", onKey);
	document.addEventListener("keydown", onFind, true);
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("focus", onFocus);
	window.addEventListener("pagehide", flush);

	// ---- запуск
	const start = resume.start;
	showMode();
	showWord(start);
	setUrl();
	scheduleSave();
	startMode(mode, start)
		.catch((e) => {
			console.error(e);
			if (!isDisposed()) showFailure(e);
		})
		.finally(runPending);

	return () => {
		if (isDisposed()) return;
		startSeq++;
		// сначала закрываем режим (печать при этом сообщает итоги), потом одно сохранение
		chip.destroy();
		view?.destroy();
		view = null;
		flush();
		setDisposed(true);
		clearTimeout(saveTimer);
		clearTimeout(flashTimer);
		for (const close of sheetClosers) close();
		document.removeEventListener("keydown", onKey);
		document.removeEventListener("keydown", onFind, true);
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("focus", onFocus);
		window.removeEventListener("pagehide", flush);
	};
}
