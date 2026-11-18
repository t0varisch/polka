import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { applyTheme, loadSettings, saveSettings, watchSystemTheme } from "./settings";
import { askPersist } from "./library/db";
import type { Mode } from "./types";
import { toast } from "./ui/dom";
import { openLibrary } from "./ui/library";
import { openBookStub } from "./ui/book-stub";

const root = document.getElementById("app") as HTMLElement;
const settings = loadSettings();
let cleanup: (() => void) | null = null;
let routeSeq = 0;

applyTheme(settings);
watchSystemTheme(() => settings);
// Просим браузер не вычищать книги из IndexedDB (на iPhone без этого Safari может удалить данные)
askPersist();

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
			? await openBookStub(root, decodeURIComponent(m[1]), (m[2] as Mode | undefined) ?? null, { goLibrary: () => (location.hash = "#/") })
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
		toast("Что-то сломалось. Обнови страницу.", 5000);
	}
}

window.addEventListener("hashchange", route);
route();

try {
	registerSW({ immediate: true });
} catch {
	/* без офлайна тоже работает */
}
