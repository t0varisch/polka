// «Поделиться книгой»: файл через системное окно или скачиванием, на ПК с папкой — полный путь
import type { Library } from "../library/types";
import type { Settings } from "../settings";
import type { BookFormat } from "../types";
import { h, openSheet, toast } from "./dom";
import { copyText } from "./send-text";

/** Путь к папке без слэша на конце, если последняя папка в нём называется как папка библиотеки; иначе null */
export function baseFor(path: string, folderName: string): string | null {
	const base = path.trim().replace(/[\\/]+$/, "");
	if (!base) return null;
	const last = base.slice(Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/")) + 1);
	return last.toLowerCase() === folderName.toLowerCase() ? base : null;
}

/** Полный путь книги на ПК: папка + путь внутри неё, слэши — как в Windows */
export function fullPath(base: string, rel: string): string {
	return `${base}\\${rel}`.replace(/\//g, "\\");
}

function isTouch(): boolean {
	return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

function canTryShare(): boolean {
	return isTouch() && typeof navigator.share === "function";
}

function download(file: File): void {
	const url = URL.createObjectURL(file);
	const a = h("a", { href: url, download: file.name });
	a.style.display = "none";
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Вызывать прямо из обработчика нажатия, без await до него: iPhone Safari требует жест для share.
 * Касание и есть navigator.share → системное окно; иначе или при отказе — скачивание
 */
export async function shareOrSave(file: File, title: string): Promise<"shared" | "saved" | "cancelled"> {
	if (canTryShare()) {
		const data: ShareData = { files: [file], title };
		// canShare — не ворота: false сразу сохраняет, а true или отсутствие функции — пробуем share
		const can = typeof navigator.canShare === "function" ? navigator.canShare(data) : true;
		if (can) {
			try {
				await navigator.share(data);
				return "shared";
			} catch (e) {
				if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
				// NotAllowedError, TypeError и прочее — сохраняем
			}
		}
	}
	download(file);
	return "saved";
}

interface PathOpts {
	folderName: string;
	settings: Settings;
	saveSettings(): void;
}

/** Поле ввода пути к папке на ПК; onSaved зовётся после верного пути */
function pathForm(o: PathOpts, onSaved: () => void): HTMLElement {
	const input = h("input", { type: "text", placeholder: "D:\\Книги", "aria-label": `Путь к папке «${o.folderName}»`, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
	const err = h("p.share-error", { role: "alert" });
	const save = h("button.primary", { type: "button" }, "Сохранить путь");
	save.addEventListener("click", () => {
		const base = baseFor(input.value, o.folderName);
		if (!base) {
			err.textContent = `Последняя папка в пути должна называться «${o.folderName}»`;
			return;
		}
		err.textContent = "";
		o.settings.folderPath = base;
		o.saveSettings();
		onSaved();
	});
	return h("div.share-path-form", {}, h("label.share-label", {}, `Путь к папке «${o.folderName}»`, input), err, save);
}

export function openPathSheet(o: PathOpts): () => void {
	const body = h("div.share");
	const show = () => {
		const base = baseFor(o.settings.folderPath, o.folderName);
		if (base) {
			body.replaceChildren(
				h("p.share-label", {}, `Путь к папке «${o.folderName}»`),
				h("code.share-path", {}, base),
				h("button.secondary", { type: "button", onclick: () => body.replaceChildren(pathForm(o, show)) }, "Изменить"),
			);
		} else body.replaceChildren(pathForm(o, show));
	};
	show();
	return openSheet("Путь к папке", body);
}

export interface ShareOpts extends Omit<PathOpts, "folderName"> {
	title: string;
	format: BookFormat;
	lib: Library;
	key: string;
	rel: string | null;
	folderName: string | null;
	addFile(): void;
}

export function openShareSheet(o: ShareOpts): () => void {
	const body = h("div.share");
	const close = openSheet("Поделиться книгой", body);
	let closed = false;
	const sheetClose = () => {
		closed = true;
		close();
	};

	if (o.lib.kind === "folder" && o.folderName) {
		const name = o.folderName;
		const show = () => {
			const base = baseFor(o.settings.folderPath, name);
			if (!base) return body.replaceChildren(pathForm({ folderName: name, settings: o.settings, saveSettings: o.saveSettings }, show));
			const text = o.rel ? fullPath(base, o.rel) : base;
			const copy = h("button.primary", { type: "button" }, "Скопировать путь");
			copy.addEventListener("click", () => {
				void copyText(text).then((r) => toast(r === "copied" ? "Путь скопирован" : "Не удалось скопировать"));
			});
			body.replaceChildren(h("code.share-path", {}, text), copy);
		};
		show();
		return sheetClose;
	}

	const wait = h("button.primary", { type: "button", disabled: true }, "Готовлю файл…");
	body.append(wait);
	const tried = canTryShare();
	const orig = o.lib.original ? o.lib.original(o.key) : Promise.resolve(null);
	orig.then(
		(file) => {
			if (closed) return;
			if (!file) return noFile();
			const btn = h("button.primary", { type: "button" }, tried ? "Отправить файл" : "Сохранить файл");
			btn.addEventListener("click", () => {
				// без await до вызова: share требует жест нажатия
				void shareOrSave(file, o.title).then((r) => {
					if (r === "saved") toast(tried ? "Окно «Поделиться» не приняло файл — сохранил в Загрузки" : "Файл сохранён в Загрузки");
				});
			});
			wait.replaceWith(btn);
		},
		() => !closed && noFile(),
	);

	function noFile(): void {
		const add = h("button.primary", { type: "button" }, "Добавить файл");
		add.addEventListener("click", () => {
			sheetClose();
			o.addFile();
		});
		body.replaceChildren(h("p", {}, "Файла этой книги нет на устройстве — добавь его ещё раз, место и закладки сохранятся"), add);
	}

	return sheetClose;
}
