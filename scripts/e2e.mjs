// Сквозная проверка Полки: режим браузера (импорт, страницы, по слову, печать, страницы, перезагрузка)
// и режим папки (?testfolder, только chromium).
// Сначала `npm run build`: скрипт без BASE сам поднимает `vite preview` на собранном dist/.
// Запуск: BOOK=путь.fb2 [SIZES=390x844,320x640,1280x800] [BROWSER=chromium|webkit] [BASE=http://...] [OUT=test-output] node scripts/e2e.mjs
import { chromium, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const BOOK = process.env.BOOK;
if (!BOOK) {
	console.error("Нужен BOOK=путь/к/книге.fb2");
	process.exit(2);
}
const SIZES = (process.env.SIZES ?? "390x844,320x640,1280x800").split(",").map((s) => s.split("x").map(Number));
const BROWSER = process.env.BROWSER ?? "chromium";
const OUT = resolve(process.env.OUT ?? "test-output");
mkdirSync(OUT, { recursive: true });
const bookName = basename(BOOK).replace(/\.[^.]+$/, "");

let failed = 0;
const step = (ok, name, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	return ok;
};

async function freePort() {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
		s.on("error", rej);
	});
}

let server = null;
let base = process.env.BASE;
if (!base) {
	const port = await freePort();
	server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
	base = `http://127.0.0.1:${port}/`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(base)).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
}
// гасим только свой сервер
const stopServer = () => server && !server.killed && server.kill();
process.on("exit", stopServer);

const launcher = BROWSER === "webkit" ? webkit : chromium;
const browser = await (BROWSER === "chromium" ? launcher.launch({ channel: "chrome" }).catch(() => launcher.launch()) : launcher.launch());

const dw = (p) => p.evaluate(() => Number(document.querySelector("div.book").dataset.word));
const dm = (p) => p.evaluate(() => document.querySelector("div.book").dataset.mode);
const onOpenPage = (p) =>
	p.evaluate(() => {
		const w = document.querySelector("div.book").dataset.word;
		const sp = document.querySelector(`.pg-content span[data-w="${w}"]`);
		const vp = document.querySelector(".pg-viewport");
		if (!sp || !vp) return false;
		const v = vp.getBoundingClientRect();
		const r = sp.getBoundingClientRect();
		return r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
	});
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function toMode(page, m, ready) {
	if ((await dm(page)) !== m) await page.click(`[data-m="${m}"]`);
	await page.waitForSelector(ready, { timeout: 30000 });
	await page.waitForTimeout(500);
}

async function browserFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-browser-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message)); // это предупреждение WebKit безобидно
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} ошибка в консоли`, m.text()));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		const w0 = await dw(page);
		step(await onOpenPage(page), `${tag} браузер: импорт, страницы`, `слово ${w0}`);
		await shot("1-pages");

		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(150);
		}
		const w3 = await dw(page);
		step(w3 > w0 && (await onOpenPage(page)), `${tag} браузер: вперёд 3 страницы`, `${w0} -> ${w3}`);
		await shot("2-pages-forward3");

		// смена размера окна и размера текста: слово-якорь остаётся на открытой странице
		const alt = W >= 800 ? [390, 844] : [W === 390 ? 1280 : 1100, 700];
		await page.setViewportSize({ width: alt[0], height: alt[1] });
		await page.waitForTimeout(900);
		step((await dw(page)) === w3 && (await onOpenPage(page)), `${tag} браузер: смена окна на ${alt[0]}x${alt[1]}, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2a-resized");
		await page.setViewportSize({ width: W, height: H });
		await page.waitForTimeout(900);
		step((await dw(page)) === w3 && (await onOpenPage(page)), `${tag} браузер: окно вернули, слово на странице`, `${w3} -> ${await dw(page)}`);
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		const size = page.locator('.sheet-backdrop input[aria-label="Размер текста"]');
		const size0 = await size.inputValue();
		await size.fill("30");
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step((await dw(page)) === w3 && (await onOpenPage(page)), `${tag} браузер: размер текста ${size0} -> 30 px, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2b-font-30");
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		await page.locator('.sheet-backdrop input[aria-label="Размер текста"]').fill("14");
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step((await dw(page)) === w3 && (await onOpenPage(page)), `${tag} браузер: размер текста 14 px, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2c-font-14");
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		await page.locator('.sheet-backdrop input[aria-label="Размер текста"]').fill(size0);
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step((await dw(page)) === w3 && (await onOpenPage(page)), `${tag} браузер: размер текста вернули (${size0} px), слово на странице`, `${w3} -> ${await dw(page)}`);

		await toMode(page, "words", ".mode-words .word .p");
		step((await dw(page)) === w3, `${tag} браузер: «По слову» то же слово`, `${await dw(page)} == ${w3}`);
		await shot("3-words");
		await page.click(".play");
		await page.waitForTimeout(2000);
		await page.click(".play");
		await page.waitForTimeout(400);
		const wp = await dw(page);
		step(wp > w3, `${tag} браузер: пуск на 2 с продвинул слово`, `${w3} -> ${wp}`);
		await shot("4-words-paused");

		await toMode(page, "typing", ".mode-typing .tape span.cur");
		step((await dw(page)) === wp, `${tag} браузер: «Печать» то же слово`, `${await dw(page)} == ${wp}`);
		const ahead = await page.evaluate(() => {
			const spans = [...document.querySelectorAll(".mode-typing .tape span")];
			const i = spans.findIndex((s) => s.classList.contains("cur"));
			return spans.slice(i, i + 160).map((s) => s.textContent).join("");
		});
		// два слова = два куска с буквой или цифрой; одинокое тире считается куском текста, но не словом
		let m = null;
		{
			const re = /[^\s¶]+[ ¶]/g;
			let n = 0, end = 0, t;
			while (n < 2 && (t = re.exec(ahead))) {
				if (/[\p{L}\p{N}]/u.test(t[0])) n++;
				end = re.lastIndex;
			}
			if (n === 2) m = [ahead.slice(0, end), ahead.slice(0, end)];
		}
		if (!step(!!m, `${tag} браузер: на ленте видны два слова`)) throw new Error("нет текста ленты");
		await page.click(".mode-typing .tape-wrap");
		await page.keyboard.type(m[1].replace(/¶/g, "\n"), { delay: 8 });
		await page.waitForTimeout(400);
		const wt = await dw(page);
		step(wt === wp + 2, `${tag} браузер: напечатано 2 слова`, `${wp} -> ${wt}`);
		await shot("5-typing");

		await toMode(page, "pages", ".pg-content span[data-w]");
		step((await onOpenPage(page)) && (await dw(page)) === wt, `${tag} браузер: «Страницы», слово на открытой странице`, `слово ${await dw(page)}`);
		await shot("6-pages-back");
		step(!(await hscroll(page)), `${tag} браузер: нет горизонтальной прокрутки`);

		await page.waitForTimeout(3500); // запись места
		const wBefore = await dw(page);
		await page.reload();
		await page.waitForSelector("div.book[data-mode]", { timeout: 30000 });
		await page.waitForSelector(".pg-content span[data-w]", { timeout: 30000 });
		await page.waitForTimeout(600);
		const mode = await dm(page);
		step(mode === "pages" && (await dw(page)) === wBefore && (await onOpenPage(page)), `${tag} браузер: после перезагрузки режим и слово те же`, `${mode}, ${await dw(page)} == ${wBefore}`);
		await shot("7-after-reload");
	} catch (e) {
		step(false, `${tag} браузер: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-browser-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

async function folderFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-folder-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message)); // это предупреждение WebKit безобидно
	try {
		await page.goto(base + "?testfolder");
		await page.waitForSelector(".library .actions");
		const bytes = [...readFileSync(BOOK)];
		await page.evaluate(
			async ([b, name]) => {
				const root = await navigator.storage.getDirectory();
				const d = await root.getDirectoryHandle("testbooks", { create: true });
				for await (const k of d.keys()) await d.removeEntry(k, { recursive: true });
				const f = await d.getFileHandle(name, { create: true });
				const wr = await f.createWritable();
				await wr.write(new Uint8Array(b));
				await wr.close();
			},
			[bytes, basename(BOOK)],
		);
		await page.reload();
		await page.waitForSelector("article.book");
		await shot("1-library");
		await page.click(".book-open");
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		const w0 = await dw(page);
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(150);
		}
		const w3 = await dw(page);
		step(w3 > w0, `${tag} папка: вперёд 3 страницы`, `${w0} -> ${w3}`);
		await shot("2-pages-forward3");
		await page.waitForTimeout(3500);
		const saved = await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const d = await root.getDirectoryHandle("testbooks");
			const s = await d.getDirectoryHandle(".polka");
			const f = await (await s.getFileHandle("progress.json")).getFile();
			return JSON.parse(await f.text());
		});
		const pos = Object.values(saved.books ?? {})[0]?.position;
		step(saved.version === 1 && pos?.word === w3 && pos?.mode === "pages", `${tag} папка: в .polka/progress.json слово и режим`, JSON.stringify(pos));
	} catch (e) {
		step(false, `${tag} папка: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-folder-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

console.log(`# ${BROWSER}, книга ${basename(BOOK)}, ${base}, снимки в ${OUT}`);
for (const [W, H] of SIZES) {
	const tag = `${BROWSER}-${bookName}-${W}x${H}`;
	console.log(`## ${W}x${H}`);
	await browserFlow(W, H, tag);
	if (BROWSER === "chromium") await folderFlow(W, H, tag);
	else console.log("SKIP режим папки: в WebKit нет showDirectoryPicker, запись в OPFS в Safari только из воркера");
}
await browser.close();
stopServer();
console.log(failed ? `ИТОГ: провалов ${failed}` : "ИТОГ: всё прошло");
process.exit(failed ? 1 : 0);
