import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { applyTheme, loadSettings, saveSettings, watchSystemTheme } from "./settings";
import { askPersist, dbEvents } from "./library/db";
import type { Mode } from "./types";
import { toast } from "./ui/dom";
import { openLibrary } from "./ui/library";
import { openBook } from "./ui/book";

const root = document.getElementById("app") as HTMLElement;
const settings = loadSettings();
let cleanup: (() => void) | null = null;
let routeSeq = 0;

applyTheme(settings);
watchSystemTheme(() => settings);
// Просим браузер не вычищать книги из IndexedDB (на iPhone без этого Safari может удалить данные)
askPersist();
dbEvents.onBlocked = () => toast("Закрой другие окна Полки — обновляется хранилище", 6000);

function persist(): void {
	saveSettings(settings);
	applyTheme(settings);
}

async function route(): Promise<void> {
	const seq = ++routeSeq;
	cleanup?.();
	cleanup = null;
	const m = location.hash.match(/^#\/read\/([^/]+)(?:\/(pages|words|typing))?$/);
	try {
		const done = m
			? await openBook(root, decodeURIComponent(m[1]), (m[2] as Mode | undefined) ?? null, {
					settings,
					saveSettings: persist,
					goLibrary: () => (location.hash = "#/"),
					alive: () => seq === routeSeq,
				})
			: await openLibrary(root, {
					settings,
					saveSettings: persist,
					onSettingsChange: () => applyTheme(settings),
					openBook: (key) => (location.hash = `#/read/${encodeURIComponent(key)}`),
				});
		if (seq === routeSeq) cleanup = done;
		else done();
	} catch (e) {
		console.error(e);
		toast("Что-то сломалось — обнови страницу", 5000);
	}
}

window.addEventListener("hashchange", route);
route();

try {
	registerSW({ immediate: true });
} catch {
	/* без офлайна тоже работает */
}
