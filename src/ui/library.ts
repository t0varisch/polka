import { currentLibrary, type FolderState, forgetFolder, pickFolder, regrantFolder } from "../library";
import { askPersist } from "../library/db";
import { BOOK_FILE } from "../library/folder";
import type { Library, ShelfItem } from "../library/types";
import type { Settings } from "../settings";
import type { BookRecord, Mode } from "../types";
import { formatDuration, h, icon, iconButton, openSheet, plural, toast } from "./dom";
import { inAppBrowser, isStandalone, platform } from "./inapp";
import { withProgress } from "./progress";
import { openSettings } from "./settings-sheet";

export interface LibraryCtx {
	settings: Settings;
	saveSettings(): void;
	onSettingsChange(): void;
	/** Ключ книги: id или `f:путь` для неоткрытой в папке. */
	openBook(key: string): void;
}

/** Средний множитель пауз — для оценки «осталось» без разбора книги. */
const AVG_PAUSE = 1.3;
const PAGES_WPM = 230;
const TYPING_DEFAULT_CPM = 200;
const CHARS_PER_WORD = 6;

const MODE_ICON: Record<Mode, string> = { pages: "book", words: "play", typing: "keyboard" };
const MODE_LABEL: Record<Mode, string> = { pages: "страницы", words: "по слову", typing: "печать" };

function remainingMs(r: BookRecord, s: Settings): number {
	const left = Math.max(0, r.wordCount - r.position.word);
	const m = r.position.mode;
	if (m === "pages") return (left * 60000) / PAGES_WPM;
	if (m === "words") return (left * AVG_PAUSE * 60000) / s.wpm;
	const t = r.typing;
	const cpm = t.activeMs >= 60000 ? t.correct / (t.activeMs / 60000) : TYPING_DEFAULT_CPM;
	return ((left * CHARS_PER_WORD) / Math.max(1, cpm)) * 60000;
}

/** Плашка «открой в настоящем браузере» для встроенных окон Telegram и других приложений. */
function inAppBanner(app: string): HTMLElement {
	const p = platform();
	const where = app === "приложения" ? "во встроенном окне приложения" : `во встроенном браузере ${app}`;
	const how =
		p === "ios"
			? app === "Telegram"
				? "Нажми на компас внизу справа или «⋯» → «Открыть в Safari»"
				: "Нажми «⋯» или «Поделиться» → «Открыть в Safari»"
			: "Нажми «⋮» вверху справа → «Открыть в браузере» (Chrome)";
	const url = location.href.split("#")[0];
	const copy = h("button.secondary", { type: "button" }, "Скопировать ссылку");
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(url);
			toast("Ссылка скопирована — вставь её в Safari или Chrome");
		} catch {
			toast(url, 6000);
		}
	});
	const actions = h("div.banner-actions", {}, copy);
	if (p === "android") {
		const host = url.replace(/^https?:\/\//, "");
		actions.prepend(h("a.primary", { href: `intent://${host}#Intent;scheme=https;package=com.android.chrome;end` }, "Открыть в Chrome"));
	}
	return h(
		"div.banner",
		{ role: "alert" },
		h("strong", {}, `Ты открыл «Полку» ${where}`),
		h("p", {}, "Здесь книги могут пропасть, а приложение не поставить на экран. Открой ссылку в обычном браузере. ", how),
		actions,
	);
}

function installHint(): HTMLElement | null {
	if (isStandalone()) return null;
	const p = platform();
	if (p === "ios") return h("p.hint", {}, "Чтобы читать как приложение: «Поделиться» (в новом Safari — через «⋯») → «На экран „Домой“»");
	if (p === "android") return h("p.hint", {}, "Чтобы читать как приложение: меню «⋮» в Chrome → «Установить приложение»");
	return null;
}

export async function openLibrary(root: HTMLElement, ctx: LibraryCtx): Promise<() => void> {
	// Без accept: iOS не знает .fb2 и делает такие файлы в «Файлах» серыми. Формат определяется по содержимому
	const fileInput = h("input", { type: "file", multiple: true, hidden: true });
	const top = h("div.lib-top");
	const list = h("div.books");
	const busy = h("div.busy", { "aria-live": "polite" });
	const app = inAppBrowser();
	let cur: { lib: Library; folder: FolderState; folderName?: string } | null = null;

	const view = h(
		"div.library",
		{},
		h(
			"header.lib-head",
			{},
			h("div", {}, h("h1", {}, "Полка"), h("p.tagline", {}, "Книги страницами, по слову и печатая")),
			iconButton("gear", "Настройки", () => openSettings(ctx.settings, () => (ctx.saveSettings(), ctx.onSettingsChange(), render()))),
		),
		top,
		app ? inAppBanner(app) : installHint(),
		busy,
		list,
		fileInput,
	);
	root.replaceChildren(view);

	async function folderAction(fn: () => Promise<unknown>): Promise<void> {
		try {
			await fn();
		} catch (e) {
			toast(e instanceof Error ? e.message : "Не получилось");
		}
		render();
	}

	function buildTop(c: NonNullable<typeof cur>): HTMLElement[] {
		const addBtn = (label: string) => h("button.primary", { type: "button", onclick: () => fileInput.click() }, icon("book", 20), label);
		const pasteBtn = h("button.secondary", { type: "button", onclick: () => pasteText() }, icon("text", 20), "Вставить текст");
		const name = c.folderName ?? "";
		if (c.folder === "granted") {
			return [
				h(
					"div.folder-row",
					{},
					h("span.folder-name", {}, icon("folder", 18), h("span", {}, `Папка «${name}»`)),
					h("button.link", { type: "button", onclick: () => folderAction(pickFolder) }, "Сменить"),
					h("button.link", { type: "button", onclick: () => folderAction(forgetFolder) }, "Отключить папку"),
				),
				h("div.actions", {}, addBtn("Добавить книгу"), pasteBtn),
			];
		}
		const out: HTMLElement[] = [];
		if (c.folder === "needs-permission") {
			out.push(h("button.primary.wide", { type: "button", onclick: () => folderAction(regrantFolder) }, icon("folder", 20), `Открыть папку «${name}»`));
		}
		out.push(h("div.actions", {}, addBtn("Открыть книгу"), pasteBtn));
		if (c.folder === "none") {
			out.push(
				h("div.actions", {}, h("button.secondary", { type: "button", onclick: () => folderAction(pickFolder) }, icon("folder", 20), "Выбрать папку с книгами")),
				h("p.formats", {}, "Книги и прогресс будут лежать в этой папке"),
			);
		}
		out.push(h("p.formats", {}, "FB2, EPUB, TXT, PDF. Книга остаётся на этом устройстве"));
		return out;
	}

	async function render(): Promise<void> {
		const c = await currentLibrary();
		cur = c;
		top.replaceChildren(...buildTop(c));
		const items = await c.lib.list();
		list.replaceChildren();
		if (items.length === 0) {
			list.append(h("p.empty", {}, c.folder === "granted" ? "В папке пока нет книг. Положи туда файл или добавь книгу" : "Здесь пока пусто. Открой книгу — и начнём"));
			return;
		}
		for (const it of items) list.append(card(c.lib, it));
	}

	function card(lib: Library, it: ShelfItem): HTMLElement {
		const r = it.record;
		const title = r ? r.title : (it.fileName ?? it.key).replace(BOOK_FILE, "");
		let pct = 0;
		let status = "Новая";
		if (r) {
			pct = r.wordCount > 1 ? Math.min(100, (r.position.word / (r.wordCount - 1)) * 100) : 0;
			const left = formatDuration(remainingMs(r, ctx.settings));
			status =
				r.position.word === 0
					? `${r.wordCount.toLocaleString("ru")} ${plural(r.wordCount, "слово", "слова", "слов")} · ≈ ${left}`
					: pct >= 99.9
						? "Дочитана"
						: `${Math.round(pct)}% · осталось ≈ ${left}`;
		}
		const mode = r?.position.mode;
		return h(
			"article.book",
			{},
			h(
				"button.book-open",
				{ type: "button", onclick: () => ctx.openBook(it.key) },
				h("span.book-name", {}, title),
				r?.author ? h("span.book-author", {}, r.author) : null,
				r ? h("span.book-progress", {}, h("i", { style: `width:${pct}%` })) : null,
				h("span.book-status", {}, mode ? h("span.book-mode", { title: MODE_LABEL[mode] }, icon(MODE_ICON[mode], 14)) : null, status),
			),
			lib.remove
				? iconButton("trash", "Удалить книгу", async () => {
						if (!confirm(`Удалить «${title}» с этого устройства?`)) return;
						await lib.remove!(it.key);
						render();
					})
				: null,
		);
	}

	async function importFiles(files: File[]): Promise<void> {
		if (files.length === 0) return;
		askPersist();
		const { lib } = cur ?? (await currentLibrary());
		let lastKey = "";
		for (const f of files) {
			try {
				const keys = await withProgress(busy, f.name, (p) => lib.addFiles([f], p));
				if (keys[0]) lastKey = keys[0];
			} catch (e) {
				toast(`«${f.name}»: ${e instanceof Error ? e.message : "не получилось открыть"}`, 6000);
			}
		}
		busy.textContent = "";
		if (files.length === 1 && lastKey) ctx.openBook(lastKey);
		else render();
	}

	function pasteText(): void {
		const title = h("input", { type: "text", placeholder: "Название (необязательно)", "aria-label": "Название" });
		const area = h("textarea", { rows: 10, placeholder: "Вставь сюда статью или главу", "aria-label": "Текст" });
		const go = h("button.primary", { type: "button" }, "Читать");
		const body = h("div.paste", {}, title, area, go);
		const close = openSheet("Свой текст", body);
		go.addEventListener("click", async () => {
			const text = area.value.trim();
			if (!text) return area.focus();
			const name = title.value.trim() || `Текст от ${new Date().toLocaleDateString("ru")}`;
			try {
				const { lib } = cur ?? (await currentLibrary());
				const key = await lib.addText(name, text);
				close();
				ctx.openBook(key);
			} catch (e) {
				toast(e instanceof Error ? e.message : "Не получилось");
			}
		});
		setTimeout(() => area.focus(), 250);
	}

	fileInput.addEventListener("change", () => {
		const files = Array.from(fileInput.files ?? []);
		fileInput.value = "";
		importFiles(files);
	});

	// Перетаскивание файла на окно (компьютер)
	const onDragOver = (e: DragEvent) => {
		if (!e.dataTransfer?.types.includes("Files")) return;
		e.preventDefault();
		view.classList.add("dragging");
	};
	const onDragLeave = (e: DragEvent) => {
		if (e.relatedTarget === null) view.classList.remove("dragging");
	};
	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		view.classList.remove("dragging");
		importFiles(Array.from(e.dataTransfer?.files ?? []));
	};
	window.addEventListener("dragover", onDragOver);
	window.addEventListener("dragleave", onDragLeave);
	window.addEventListener("drop", onDrop);

	await render();

	return () => {
		window.removeEventListener("dragover", onDragOver);
		window.removeEventListener("dragleave", onDragLeave);
		window.removeEventListener("drop", onDrop);
	};
}
