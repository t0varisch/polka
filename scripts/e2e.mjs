// Сквозная проверка Полки: режим браузера (импорт, страницы, по слову, печать, страницы, перезагрузка)
// и режим папки (?testfolder, только chromium).
// Сначала `npm run build`: скрипт без BASE сам поднимает `vite preview` на собранном dist/.
// Рисунки: IMG_BOOK=путь.fb2 вместо BOOK — сценарий с рисунками на страницах и просмотром на весь экран.
// Запуск: BOOK=путь.fb2 [SIZES=390x844,320x640,1280x800] [BROWSER=chromium|webkit] [BASE=http://...] [OUT=test-output] node scripts/e2e.mjs
// Поиск по книге (searchFlow) идёт в сценарии BOOK=, не в IMG_BOOK.
import { chromium, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const IMG = !!process.env.IMG_BOOK;
const BOOK = process.env.IMG_BOOK ?? process.env.BOOK;
if (!BOOK) {
	console.error("Нужен BOOK=путь/к/книге.fb2 или IMG_BOOK=путь/к/книге.fb2");
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
// Рисунок, видимый на открытой странице (по горизонтали пересекает окно), с проверками
const figInfo = (p) =>
	p.evaluate(() => {
		const vp = document.querySelector(".pg-page").getBoundingClientRect(); // видимая область: страница обрезает соседние колонки
		const inside = (r) => r.left >= vp.left - 1 && r.right <= vp.right + 1 && r.top >= vp.top - 1 && r.bottom <= vp.bottom + 1;
		for (const img of document.querySelectorAll("img.pg-img")) {
			const r = img.getBoundingClientRect();
			if (r.right <= vp.left + 1 || r.left >= vp.right - 1) continue;
			const cap = img.closest("figure")?.querySelector(".pg-cap");
			const cr = cap?.getBoundingClientRect();
			const body = document.querySelector(".pg-content p:not(.pg-cap)");
			return {
				i: img.dataset.i,
				ok: img.complete && img.naturalWidth > 0,
				inside: inside(r),
				cap: cap ? cap.textContent : null,
				capTag: cap ? cap.tagName : null,
				capInside: cr ? inside(cr) : null,
				capFont: cap ? getComputedStyle(cap).fontFamily : null,
				bodyFont: body ? getComputedStyle(body).fontFamily : null,
				box: [Math.round(r.width), Math.round(r.height)],
			};
		}
		return null;
	});
// Ждёт конца анимации листания: промеры после клавиши иначе попадают в середину съезда
const settle = (p) => p.waitForFunction(() => document.querySelector(".pg-content")?.getAnimations().length === 0, null, { timeout: 5000 }).catch(() => {});
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

		// промахи подряд на одной букве — одна ошибка: точность после второго и третьего промаха не падает
		{
			const acc = () =>
				page.evaluate(() => {
					const st = [...document.querySelectorAll(".mode-typing .stat")].find((d) => d.querySelector("small")?.textContent === "точность");
					return st?.querySelector("b")?.textContent ?? "";
				});
			const cur = await page.evaluate(() => document.querySelector(".mode-typing .tape span.cur")?.textContent ?? "");
			const wrong = /[ъЪ]/.test(cur) ? "ж" : "ъ";
			await page.keyboard.type(wrong);
			await page.waitForTimeout(150);
			const a1 = await acc();
			await page.keyboard.type(wrong + wrong, { delay: 30 });
			await page.waitForTimeout(150);
			const a3 = await acc();
			step(a1 !== "100,0%" && a1 === a3, `${tag} браузер: три промаха на одной букве — одна ошибка`, `${a1} -> ${a3}`);
			await page.keyboard.type(cur === "¶" ? "\n" : cur);
			await page.waitForTimeout(150);
			const a4 = await acc();
			step((await dw(page)) >= wt && a4 !== a3, `${tag} браузер: после верной буквы точность пересчитана`, `${a3} -> ${a4}`);
		}

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

// Листает вперёд до страницы с рисунком (у chipolla — с подписью «Рис.»), не больше 300 страниц
async function findFigPage(page) {
	const want = bookName === "chipolla" ? (f) => f.cap && f.cap.includes("Рис.") : () => true;
	let stuck = 0;
	for (let n = 0; n < 300; n++) {
		const f = await figInfo(page);
		if (f && want(f)) return f;
		const w = await dw(page);
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(60);
		await settle(page);
		const w2 = await dw(page);
		stuck = w2 === w && !(await figInfo(page)) ? stuck + 1 : 0;
		if (stuck >= 3) break;
	}
	return null;
}
// Страница из одних рисунков: рисунок виден, ни одного слова на открытой странице нет
const wordsVisible = (p) =>
	p.evaluate(() => {
		const vp = document.querySelector(".pg-page").getBoundingClientRect();
		return [...document.querySelectorAll(".pg-content span[data-w]")].some((s) => {
			const r = s.getBoundingClientRect();
			return r.right > vp.left + 1 && r.left < vp.right - 1;
		});
	});
async function findImageOnlyPage(page) {
	let stuck = 0;
	for (let n = 0; n < 300; n++) {
		const f = await figInfo(page);
		if (f && !(await wordsVisible(page))) return f;
		const w = await dw(page);
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(60);
		await settle(page);
		stuck = (await dw(page)) === w && !(await figInfo(page)) ? stuck + 1 : 0;
		if (stuck >= 3) break;
	}
	return null;
}
const imgSel = (i) => 'img.pg-img[data-i="' + i + '"]';

async function imgFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-img-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} ошибка в консоли`, m.text()));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");

		// 1. страница с рисунком
		const f0 = await findFigPage(page);
		if (!step(!!f0, `${tag} рисунки: страница с рисунком найдена`, f0 ? `рисунок ${f0.i}, ${f0.box.join("x")}` : "")) throw new Error("нет страницы с рисунком");
		step(f0.ok && f0.inside, `${tag} рисунки: загружен, целиком в окне страниц`, JSON.stringify(f0.box));
		if (bookName === "chipolla") {
			step(f0.capTag === "P" && f0.cap.includes("Рис.") && f0.capInside, `${tag} рисунки: подпись «Рис.» на той же странице`, f0.cap);
			step(!!f0.capFont && f0.capFont !== f0.bodyFont, `${tag} рисунки: шрифт подписи другой`, `${f0.capFont} / ${f0.bodyFont}`);
		}
		await shot("1-page");
		const w0 = await dw(page);

		// 2. просмотр на весь экран
		await page.click(imgSel(f0.i));
		await page.waitForSelector(".pg-viewer", { timeout: 5000 });
		await page.waitForTimeout(300);
		const vi = await page.evaluate(() => {
			const v = document.querySelector(".pg-viewer").getBoundingClientRect();
			const im = document.querySelector(".pg-viewer img");
			const r = im.getBoundingClientRect();
			return { full: v.width >= innerWidth - 1 && v.height >= innerHeight - 1, fits: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, ok: im.naturalWidth > 0 };
		});
		step(vi.full && vi.fits && vi.ok, `${tag} рисунки: просмотр открыт на весь экран, рисунок целиком`, JSON.stringify(vi));
		await shot("2-viewer");
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(200);
		step((await dw(page)) === w0, `${tag} рисунки: в просмотре стрелки не листают`);
		await page.mouse.click(W / 2, H / 2);
		await page.waitForTimeout(300);
		const f1 = await figInfo(page);
		step(!(await page.$(".pg-viewer")) && (await dw(page)) === w0 && !!f1 && f1.i === f0.i, `${tag} рисунки: нажатие закрыло просмотр, слово и страница те же`);
		await page.click(imgSel(f0.i));
		await page.waitForSelector(".pg-viewer");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		step(!(await page.$(".pg-viewer")) && !!(await page.$("div.book[data-mode]")) && (await dw(page)) === w0, `${tag} рисунки: Escape закрыл просмотр, остались в книге`);

		// 3. смена окна
		const alt = W >= 800 ? [390, 844] : [W === 390 ? 1280 : 1100, 700];
		await page.setViewportSize({ width: alt[0], height: alt[1] });
		await page.waitForTimeout(1000);
		const n2 = await page.evaluate(() => document.querySelectorAll("img.pg-img").length);
		const f2 = await figInfo(page);
		step(n2 > 0 && (!f2 || f2.inside) && (await dw(page)) === w0, `${tag} рисунки: смена окна на ${alt[0]}x${alt[1]}, слово то же, рисунок целиком`, f2 ? `виден ${f2.i}` : "рисунок на соседней странице");
		await shot("3-resized");
		await page.setViewportSize({ width: W, height: H });
		await page.waitForTimeout(1000);
		step((await dw(page)) === w0, `${tag} рисунки: окно вернули, слово то же`);

		// 4. «По слову» и обратно
		const w4 = await dw(page);
		await toMode(page, "words", ".mode-words .word .p");
		await toMode(page, "pages", ".pg-content span[data-w]");
		step((await dw(page)) === w4, `${tag} рисунки: «По слову» и обратно, слово то же`, `${await dw(page)} == ${w4}`);

		// 5. старый кэш: у книги убраны images и v
		await page.waitForTimeout(3500);
		const id = await page.evaluate(() => decodeURIComponent(location.hash.split("/")[2]));
		await page.evaluate(
			(key) =>
				new Promise((res, rej) => {
					const o = indexedDB.open("polka");
					o.onerror = () => rej(o.error);
					o.onsuccess = () => {
						const d = o.result;
						const tx = d.transaction("texts", "readwrite");
						const st = tx.objectStore("texts");
						const g = st.get(key);
						g.onsuccess = () => {
							const v = g.result;
							delete v.images;
							delete v.v;
							st.put(v);
						};
						tx.oncomplete = () => (d.close(), res());
						tx.onerror = () => rej(tx.error);
					};
				}),
			id,
		);
		await page.reload();
		await page.waitForSelector("div.book[data-mode]", { timeout: 30000 });
		await page.waitForSelector(".pg-content span[data-w]", { timeout: 30000 });
		await page.waitForTimeout(600);
		const noImg = await page.evaluate(() => document.querySelectorAll("img.pg-img").length);
		step(noImg === 0, `${tag} рисунки: старый кэш — книга открылась, рисунков нет`, String(noImg));
		const wOld = await dw(page);
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await page.waitForSelector(".pg-content span[data-w]", { timeout: 30000 });
		await page.waitForTimeout(800);
		const wNew = await dw(page);
		const f3 = await findFigPage(page);
		step(!!f3 && f3.ok && wNew === wOld, `${tag} рисунки: тот же файл ещё раз — рисунки появились, слово то же`, `слово ${wOld} -> ${wNew}`);
		step(!(await hscroll(page)), `${tag} рисунки: нет горизонтальной прокрутки`);

		// 6. страница из одних рисунков: после смены окна открыта страница с тем же рисунком
		{
			const fo = await findImageOnlyPage(page);
			if (fo) {
				await page.setViewportSize({ width: alt[0], height: alt[1] });
				await page.waitForTimeout(1000);
				const fo2 = await figInfo(page);
				step(!!fo2 && fo2.i === fo.i && fo2.inside, `${tag} рисунки: страница из одних рисунков, смена окна на ${alt[0]}x${alt[1]} — тот же рисунок ${fo.i} на странице`, fo2 ? `был ${fo.i}, стал ${fo2.i}` : "рисунка на странице нет");
				await shot("3a-image-only-resized");
				await page.setViewportSize({ width: W, height: H });
				await page.waitForTimeout(1000);
			} else step(bookName !== "buzunov", `${tag} рисунки: страница из одних рисунков`, bookName === "buzunov" ? "не найдена за 300 страниц" : "в этой книге не найдена, шаг пропущен");
		}
	} catch (e) {
		step(false, `${tag} рисунки: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-img-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

// Три слова подряд (только буквы) из абзаца примерно на frac книги: их ищем и ждём, что книга встанет на это слово
const pickPhrase = (p, frac) =>
	p.evaluate(async (frac) => {
		const id = decodeURIComponent(location.hash.split("/")[2]);
		const rec = await new Promise((res, rej) => {
			const o = indexedDB.open("polka");
			o.onerror = () => rej(o.error);
			o.onsuccess = () => {
				const g = o.result.transaction("texts").objectStore("texts").get(id);
				g.onsuccess = () => (o.result.close(), res(g.result));
				g.onerror = () => rej(g.error);
			};
		});
		const paras = rec.paragraphs;
		for (let i = Math.floor(paras.length * frac); i < paras.length; i++) {
			const w = paras[i].split(/\s+/);
			if (w.length >= 6 && w.slice(2, 5).every((x) => /^[\p{L}]{3,}$/u.test(x))) return { phrase: w.slice(2, 5).join(" "), para: i };
		}
		return null;
	}, frac);

// Сквозные страницы: номер в подвале растёт ровно на 1, в том числе через границу куска; первая страница — 1, последняя — M
async function pageNumberFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	const num = () =>
		page.evaluate(() => {
			const m = /стр\. (\d+) из (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "");
			return m ? [Number(m[1]), Number(m[2])] : null;
		});
	const chunkKey = () => page.evaluate(() => document.querySelector(".pg-content span[data-w]")?.getAttribute("data-w") ?? "");
	// Ползунок «Позиция» в навигации: value от 0 до 1000
	const seekSlider = async (v) => {
		await page.click('[aria-label="Оглавление и закладки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Позиция в книге"]');
		await page.evaluate((v) => {
			const el = document.querySelector('.sheet-backdrop input[aria-label="Позиция в книге"]');
			el.value = String(v);
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		}, v);
		await page.waitForTimeout(300);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
	};
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		// Первое слово может стоять после страницы из одной обложки: тогда номер 2, а назад листается до 1
		const firstPage = async () => {
			let n = await num();
			const at = n;
			if (n && n[0] === 2) {
				await page.keyboard.press("ArrowLeft");
				await page.waitForTimeout(150);
				n = await num();
			}
			return { at, n };
		};
		const first = await firstPage();
		step(first.n?.[0] === 1 && first.n[1] > 1, `${tag} номера: первая страница книги — 1`, JSON.stringify(first));

		await seekSlider(300);
		// вперёд до границы куска, потом назад на три страницы до его конца
		let k0 = await chunkKey();
		let found = false;
		for (let i = 0; i < 600 && !found; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(40);
			if ((await chunkKey()) !== k0) found = true;
		}
		if (!step(found, `${tag} номера: найдена граница куска`)) throw new Error("нет границы куска");
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowLeft");
			await page.waitForTimeout(80);
		}
		let prev = await num();
		const seq = [prev];
		let ok = true;
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(80);
			const cur = await num();
			seq.push(cur);
			if (!cur || !prev || cur[0] !== prev[0] + 1) ok = false;
			prev = cur;
		}
		const a = seq[seq.length - 1];
		const b = seq[seq.length - 2];
		step(ok, `${tag} номера: шесть листаний вперёд через границу — каждый раз +1`, seq.map((x) => x?.join("/")).join(" "));
		step(!!a && !!b && a[1] === b[1], `${tag} номера: «из M» на последних двух шагах тот же`, `${b?.[1]} ${a?.[1]}`);
		await page.screenshot({ path: `${OUT}/${tag}-pagenum.png` });
		step(!(await hscroll(page)), `${tag} номера: нет горизонтальной прокрутки`);
		const footOk = await page.evaluate(() => {
			const f = document.querySelector(".pg-foot");
			return f.scrollWidth <= f.clientWidth + 1;
		});
		step(footOk, `${tag} номера: подвал не выходит за ширину`);

		await seekSlider(1000);
		const last = await num();
		step(!!last && last[0] === last[1], `${tag} номера: на последнем слове книги номер = M`, JSON.stringify(last));
		await seekSlider(0);
		const first2 = await firstPage();
		step(first2.n?.[0] === 1, `${tag} номера: на первом слове книги — 1`, JSON.stringify(first2));
	} catch (e) {
		step(false, `${tag} номера: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-pagenum-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

// Поиск по книге: Ctrl+F / F3 / кнопка открывают лист, найденное открывается в каждом из трёх режимов
async function searchFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-search-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} ошибка в консоли`, m.text()));
	const sheetOpen = () => page.$(".sheet-backdrop.open .search");
	const inputFocused = () => page.evaluate(() => document.activeElement === document.querySelector(".search input"));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		const btn = await page.evaluate(() => {
			const r = document.querySelector('[aria-label="Поиск по книге"]').getBoundingClientRect();
			return r.left >= 0 && r.right <= innerWidth && r.width > 0;
		});
		step(btn && !(await hscroll(page)), `${tag} поиск: кнопка в шапке видна, горизонтальной прокрутки нет`);

		const plan = [
			["pages", ".pg-content span[data-w]", 0.6, (p) => p.keyboard.press("Control+f")],
			["words", ".mode-words .word .p", 0.3, (p) => p.keyboard.press("F3")],
			["typing", ".mode-typing .tape span.cur", 0.8, (p) => p.click('[aria-label="Поиск по книге"]')],
		];
		for (const [mode, ready, frac, open] of plan) {
			await toMode(page, mode, ready);
			const pick = await pickPhrase(page, frac);
			if (!step(!!pick, `${tag} поиск [${mode}]: фраза из трёх слов найдена`, pick ? `абзац ${pick.para}: ${pick.phrase}` : "")) throw new Error("нет фразы");
			const before = await dw(page);
			if (mode === "typing") await page.click(".mode-typing .tape-wrap");
			await open(page);
			await page.waitForSelector(".sheet-backdrop.open .search input", { timeout: 3000 });
			await page.waitForTimeout(300);
			step(!!(await sheetOpen()) && (await inputFocused()), `${tag} поиск [${mode}]: лист «Поиск» открыт, поле в фокусе`);
			const query = pick.phrase.toUpperCase().replace(/Ё/g, "Е");
			await page.keyboard.type(query, { delay: 5 });
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press("Space");
			await page.waitForTimeout(500);
			step((await dw(page)) === before && (await dm(page)) === mode, `${tag} поиск [${mode}]: буквы из поля не попали в режим`, `${before} == ${await dw(page)}`);
			// пробел после ArrowRight/Space уже в поле: стираем его, чтобы запрос остался тем же
			await page.keyboard.press("Backspace");
			await page.waitForTimeout(500);
			const status = await page.textContent(".search-status");
			const first = await page.$(".search-item");
			if (!step(/^Найдено/.test(status ?? "") && !!first, `${tag} поиск [${mode}]: список`, status ?? "")) throw new Error("нет совпадений");
			await shot(`1-${mode}`);
			const target = Number(await first.getAttribute("data-word"));
			await first.click();
			await page.waitForTimeout(700);
			step(!(await sheetOpen()), `${tag} поиск [${mode}]: лист закрылся после выбора`);
			const here = await dw(page);
			step(here === target && (await dm(page)) === mode, `${tag} поиск [${mode}]: книга на слове совпадения`, `${here} == ${target}`);
			const first3 = pick.phrase.split(" ")[0].toLowerCase().replace(/ё/g, "е");
			if (mode === "pages") {
				const t = await page.evaluate(() => document.querySelector(`.pg-content span[data-w="${document.querySelector("div.book").dataset.word}"]`)?.textContent ?? "");
				step((await onOpenPage(page)) && t.toLowerCase().replace(/ё/g, "е").includes(first3), `${tag} поиск [pages]: слово на открытой странице`, t);
			} else if (mode === "words") {
				const t = await page.evaluate(() => document.querySelector(".mode-words .focus .word")?.textContent ?? "");
				step(t.toLowerCase().replace(/ё/g, "е").includes(first3), `${tag} поиск [words]: на экране слово совпадения`, t);
			} else {
				const t = await page.evaluate(() => {
					const spans = [...document.querySelectorAll(".mode-typing .tape span")];
					const i = spans.findIndex((s) => s.classList.contains("cur"));
					return spans.slice(i, i + 60).map((s) => s.textContent).join("");
				});
				step(t.toLowerCase().replace(/ё/g, "е").includes(first3), `${tag} поиск [typing]: лента стоит на слове совпадения`, t.slice(0, 40));
			}
			// сохранённое место — то же слово, что после перехода из оглавления
			await page.waitForTimeout(3500);
			const saved = await page.evaluate(
				(id) =>
					new Promise((res, rej) => {
						const o = indexedDB.open("polka");
						o.onerror = () => rej(o.error);
						o.onsuccess = () => {
							const g = o.result.transaction("books").objectStore("books").get(id);
							g.onsuccess = () => (o.result.close(), res(g.result?.position?.word));
							g.onerror = () => rej(g.error);
						};
					}),
				await page.evaluate(() => decodeURIComponent(location.hash.split("/")[2])),
			);
			step(saved === target, `${tag} поиск [${mode}]: место сохранено на слове совпадения`, `${saved} == ${target}`);

			// повторное открытие: прежний запрос и отмеченное совпадение
			if (mode === "pages") {
				await page.keyboard.press("Control+f");
				await page.waitForSelector(".sheet-backdrop.open .search input");
				await page.waitForTimeout(400);
				const re = await page.evaluate(() => {
					const i = document.querySelector(".search input");
					const pk = document.querySelector(".search-item.picked");
					const l = document.querySelector(".search-list").getBoundingClientRect();
					const r = pk?.getBoundingClientRect();
					return { q: i.value, sel: i.selectionStart === 0 && i.selectionEnd === i.value.length, picked: !!pk, seen: !!r && r.top >= l.top - 1 && r.bottom <= l.bottom + 1 };
				});
				step(re.q === query && re.sel && re.picked && re.seen, `${tag} поиск: повторное открытие — запрос выделен, совпадение отмечено и видно`, JSON.stringify(re));
				await shot("2-reopen");
				await page.keyboard.press("Escape");
				await page.waitForTimeout(400);
			}
		}
		step(!(await hscroll(page)), `${tag} поиск: нет горизонтальной прокрутки`);
	} catch (e) {
		step(false, `${tag} поиск: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-search-ERROR.png` }).catch(() => {});
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
		if (IMG) {
			const fi = await findFigPage(page);
			step(!!fi && fi.ok && fi.inside, `${tag} папка: на странице с рисунком картинка видна и целиком`, fi ? JSON.stringify(fi.box) : "нет рисунка");
			await shot("3-img");
			await ctx.close();
			return;
		}
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

// Засечки глав: на линии места и на ползунке «Позиция»; шапка и лист без горизонтальной прокрутки
async function ticksFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		const lefts = await page.$$eval(".progress .tick", (els) => els.map((e) => parseFloat(e.style.left)));
		const inRange = lefts.every((l) => l > 0 && l <= 100) && lefts.every((l, i) => i === 0 || l > lefts[i - 1]);
		await page.screenshot({ path: `${OUT}/${tag}-ticks-top.png`, clip: { x: 0, y: 0, width: W, height: 90 } });
		await page.click('[aria-label="Оглавление и закладки"]');
		await page.waitForSelector(".sheet-backdrop .toc-list");
		await page.waitForTimeout(400);
		const tocItems = await page.$$eval(".sheet-backdrop .toc-item", (els) => els.length);
		const sheetTicks = await page.$$eval(".sheet-backdrop .range-ticks .tick", (els) => els.length);
		const hs = await hscroll(page);
		await page.screenshot({ path: `${OUT}/${tag}-ticks-nav.png` });
		if (tocItems >= 2) {
			step(lefts.length > 0 && inRange, `${tag} засечки на линии места`, `${lefts.length} шт., оглавление ${tocItems}`);
			step(sheetTicks === lefts.length, `${tag} засечки на ползунке «Позиция»`, `${sheetTicks} шт.`);
		} else {
			step(lefts.length === 0 && sheetTicks === 0, `${tag} без оглавления засечек нет`, `${lefts.length}/${sheetTicks}`);
		}
		step(!hs, `${tag} засечки: нет горизонтальной прокрутки`);
		await page.keyboard.press("Escape");
	} catch (e) {
		step(false, `${tag} засечки: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-ticks-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

// Анимация листания: съезд, быстрые касания подряд, ведение пальцем, граница куска, «уменьшить движение»
async function animFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	const num = () =>
		page.evaluate(() => {
			const m = /стр\. (\d+) из (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "");
			return m ? Number(m[1]) : null;
		});
	const tx = (p = page) =>
		p.evaluate(() => {
			const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(document.querySelector(".pg-content")).transform);
			return m ? Number(m[1].split(",")[4]) : 0;
		});
	const chunkKey = () => page.evaluate(() => document.querySelector(".pg-content span[data-w]")?.getAttribute("data-w") ?? "");
	// Слово-место стоит первым в левой колонке: левый край слова у края текста страницы
	const wordAtLeft = () =>
		page.evaluate(() => {
			const w = document.querySelector("div.book").dataset.word;
			const sp = document.querySelector(`.pg-content span[data-w="${w}"]`);
			const box = document.querySelector(".pg-page").getBoundingClientRect();
			if (!sp) return false;
			const r = sp.getBoundingClientRect();
			return r.left >= box.left && r.left < box.left + 120;
		});
	const seekSlider = async (v) => {
		await page.click('[aria-label="Оглавление и закладки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Позиция в книге"]');
		await page.evaluate((v) => {
			const el = document.querySelector('.sheet-backdrop input[aria-label="Позиция в книге"]');
			el.value = String(v);
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		}, v);
		await page.waitForTimeout(300);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(600);
	};
	const cdp = BROWSER === "chromium" ? await ctx.newCDPSession(page) : null;
	// Палец: от середины на dx пикселей за steps шагов, потом выдержка; отпускание — lift()
	const swipe = async (dx, { steps = 6, stepMs = 16, hold = 0, y = Math.round(H / 2), from = Math.round(W / 2) } = {}) => {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
		for (let i = 1; i <= steps; i++) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + Math.round((dx * i) / steps), y }] });
			await page.waitForTimeout(stepMs);
		}
		if (hold) await page.waitForTimeout(hold);
	};
	const lift = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		await seekSlider(300);
		const pw = await page.evaluate(() => document.querySelector(".pg-page").getBoundingClientRect().width);

		// касание правой части: через 60 мс промежуточный сдвиг, через 400 мс — новый, место = первое слово страницы
		const x0 = await tx();
		const n0 = await num();
		const w0 = await dw(page);
		await page.mouse.click(Math.round(W * 0.8), Math.round(H / 2));
		await page.waitForTimeout(60);
		const xm = await tx();
		// WebKit в headless рисует первый кадр съезда позже 60 мс: там достаточно идущей анимации
		const running = await page.evaluate(() => document.querySelector(".pg-content").getAnimations().length > 0);
		await page.waitForTimeout(40);
		await page.screenshot({ path: `${OUT}/${tag}-anim-mid.png` });
		await page.waitForTimeout(300);
		const x1 = await tx();
		step(((xm < x0 - 1 && xm > x1 + 1) || (BROWSER === "webkit" && running)) && Math.abs(x1 - (x0 - pw)) < 1.5, `${tag} анимация: касание — промежуточный сдвиг, потом новый`, `${x0} -> ${xm} -> ${x1}`);
		step((await dw(page)) > w0 && (await wordAtLeft()) && (await num()) === n0 + 1, `${tag} анимация: место — первое слово новой страницы`, `слово ${w0} -> ${await dw(page)}`);

		// три касания с промежутком 50 мс
		const n1 = await num();
		for (let i = 0; i < 3; i++) {
			await page.mouse.click(Math.round(W * 0.8), Math.round(H / 2));
			await page.waitForTimeout(50);
		}
		await page.waitForTimeout(500);
		step((await num()) === n1 + 3 && (await wordAtLeft()) && (await onOpenPage(page)), `${tag} анимация: три касания подряд — на 3 страницы дальше, место верное`, `${n1} -> ${await num()}`);
		// клавиши подряд
		const n2 = await num();
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowLeft");
			await page.waitForTimeout(30);
		}
		await page.waitForTimeout(500);
		step((await num()) === n2 - 3 && (await wordAtLeft()), `${tag} анимация: три клавиши назад подряд`, `${n2} -> ${await num()}`);

		if (cdp) {
			// ведение пальцем: страница идёт за пальцем без анимации
			const n3 = await num();
			const xa = await tx();
			await swipe(-30, { steps: 5, stepMs: 20, hold: 250 });
			const xd = await tx();
			step(Math.abs(xd - (xa - 22)) < 3, `${tag} свайп: страница идёт за пальцем (минус порог 8 px)`, `${xa} -> ${xd}`);
			await lift();
			await page.waitForTimeout(500);
			step((await num()) === n3 && Math.abs((await tx()) - xa) < 1, `${tag} свайп: 30 px медленно — страница та же, вернулась`, `${n3} -> ${await num()}`);
			await page.waitForTimeout(450);
			await swipe(-120, { steps: 6, stepMs: 25 });
			await lift();
			await page.waitForTimeout(600);
			step((await num()) === n3 + 1 && (await wordAtLeft()), `${tag} свайп: 120 px — следующая страница`, `${n3} -> ${await num()}`);
			await page.waitForTimeout(450);
			await swipe(120, { steps: 6, stepMs: 25 });
			await lift();
			await page.waitForTimeout(600);
			step((await num()) === n3, `${tag} свайп: вправо 120 px — назад`, `-> ${await num()}`);
			await page.waitForTimeout(450);
			// рывок
			await swipe(-38, { steps: 1, stepMs: 0 });
			await lift();
			await page.waitForTimeout(600);
			step((await num()) === n3 + 1, `${tag} свайп: быстрый рывок на 38 px — листает`, `-> ${await num()}`);
		}

		// граница куска: последняя страница главы, свайп вперёд — следующая глава, номер +1
		const k0 = await chunkKey();
		let found = false;
		for (let i = 0; i < 600 && !found; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(40);
			if ((await chunkKey()) !== k0) found = true;
		}
		await page.waitForTimeout(400);
		if (!step(found, `${tag} анимация: найдена граница куска`)) throw new Error("нет границы куска");
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(500);
		const nb = await num();
		const kb = await chunkKey();
		if (cdp) {
			let xb0 = await tx();
			await swipe(-120, { steps: 6, stepMs: 25 });
			let shift = (await tx()) - xb0;
			await lift();
			// первый кадр после отпускания: новый кусок въезжает от пальца, а не от края
			let xs = await tx();
			await page.waitForTimeout(700);
			let xfin = await tx();
			step((await chunkKey()) !== kb && (await num()) === nb + 1 && (await wordAtLeft()) && (await onOpenPage(page)), `${tag} свайп: через границу куска — следующая глава, номер +1`, `${nb} -> ${await num()}`);
			step(shift < -60 && xs - (xfin + pw) < shift / 2 + 10, `${tag} свайп: через границу вперёд — въезд от пальца`, `палец ${shift}, старт ${xs - xfin} (от края ${pw})`);
			await page.waitForTimeout(450);
			xb0 = await tx();
			await swipe(120, { steps: 6, stepMs: 25 });
			shift = (await tx()) - xb0;
			await lift();
			xs = await tx();
			await page.waitForTimeout(700);
			xfin = await tx();
			step((await chunkKey()) === kb && (await num()) === nb && (await onOpenPage(page)), `${tag} свайп: обратно в прежнюю главу, номер -1`, `-> ${await num()}`);
			step(shift > 60 && xs - (xfin - pw) > shift / 2 - 10, `${tag} свайп: через границу назад — въезд от пальца`, `палец ${shift}, старт ${xs - xfin} (от края ${-pw})`);
		}
		// клавиша через границу: новый кусок въезжает справа
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(60);
		const xe = await tx();
		await page.waitForTimeout(500);
		const xf = await tx();
		step((await chunkKey()) !== kb && (await num()) === nb + 1 && xe > xf + 1, `${tag} анимация: новый кусок въезжает справа`, `${xe} -> ${xf}`);
		await page.screenshot({ path: `${OUT}/${tag}-anim-end.png` });
		step(!(await hscroll(page)), `${tag} анимация: нет горизонтальной прокрутки`);
	} catch (e) {
		step(false, `${tag} анимация: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-anim-ERROR.png` }).catch(() => {});
	}
	await ctx.close();

	// «уменьшить движение»: без перехода, листание мгновенное, свайп листает как раньше
	const ctx2 = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true, reducedMotion: "reduce" });
	const p2 = await ctx2.newPage();
	try {
		await p2.goto(base);
		await p2.waitForSelector(".library .actions");
		await p2.setInputFiles('input[type="file"]', BOOK);
		await p2.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(p2, "pages", ".pg-content span[data-w]");
		const dur = await p2.evaluate(() => getComputedStyle(document.querySelector(".pg-content")).transitionDuration);
		step(/^0s(, 0s)*$/.test(dur), `${tag} reduced-motion: transition-duration 0`, dur);
		const xa = await tx(p2);
		await p2.keyboard.press("ArrowRight");
		await p2.waitForTimeout(20);
		const xb = await tx(p2);
		step(Math.abs(xb - xa) > 1, `${tag} reduced-motion: листание мгновенное`, `${xa} -> ${xb}`);
		if (BROWSER === "chromium") {
			const c2 = await ctx2.newCDPSession(p2);
			const n = async () => p2.evaluate(() => Number(/стр\. (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "")?.[1]));
			const n0 = await n();
			const y = Math.round(H / 2);
			await c2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(W / 2), y }] });
			await c2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(W / 2) - 80, y }] });
			const xm = await tx(p2);
			await c2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await p2.waitForTimeout(100);
			step((await n()) === n0 + 1 && Math.abs(xm - (await tx(p2))) > 1, `${tag} reduced-motion: свайп листает без ведения пальцем`, `${n0} -> ${await n()}`);
		}
	} catch (e) {
		step(false, `${tag} reduced-motion: сценарий оборвался`, String(e.message).split("\n")[0]);
	}
	await ctx2.close();
}

// Закладка из выделенного текста: цитата в списке, подсветка pg-mark, выделение снято — закладка с цитатой ещё 2 с
async function markFlow(W, H, tag) {
	const ctx = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} ошибка в консоли`, m.text()));
	const marked = () => page.evaluate(() => [...document.querySelectorAll(".pg-content span.pg-mark")].map((e) => Number(e.dataset.w)));
	// Выделить слова a..b программно (Range от одного span[data-w] до другого)
	const select = (a, b) =>
		page.evaluate(([a, b]) => {
			const r = document.createRange();
			r.setStartBefore(document.querySelector(`.pg-content span[data-w="${a}"]`));
			r.setEndAfter(document.querySelector(`.pg-content span[data-w="${b}"]`));
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
			return r.toString().replace(/\s+/g, " ").trim();
		}, [a, b]);
	const bookmarkTexts = async () => {
		await page.click('[aria-label="Оглавление и закладки"]');
		await page.waitForSelector(".sheet-backdrop");
		await page.click('.sheet-backdrop [role="tab"]:nth-of-type(2)');
		const out = await page.evaluate(() => [...document.querySelectorAll(".sheet-backdrop .mark-go > span")].map((e) => ({ t: e.textContent, quote: e.classList.contains("mark-quote") })));
		return out;
	};
	const closeNav = async () => {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	};
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
		await settle(page);
		await page.waitForTimeout(300);
		// шесть слов подряд должны быть в открытом куске: у короткой главы берём последние шесть
		const w0 = await page.evaluate(() => {
			const w = Number(document.querySelector("div.book").dataset.word);
			if (document.querySelector(`.pg-content span[data-w="${w + 5}"]`)) return w;
			return Math.max(...[...document.querySelectorAll(".pg-content span[data-w]")].map((e) => Number(e.dataset.w))) - 5;
		});
		const quote = await select(w0, w0 + 5);
		await page.waitForTimeout(150);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(400);
		const m1 = await marked();
		step(m1.length === 6 && m1[0] === w0 && m1[5] === w0 + 5, `${tag} закладка-цитата: на странице подсвечены 6 слов`, m1.join(","));
		step(await page.evaluate(() => getSelection().isCollapsed), `${tag} закладка-цитата: выделение снято`);
		step((await page.textContent("#toast")) === "Цитата в закладках", `${tag} закладка-цитата: тост «Цитата в закладках»`);
		await page.screenshot({ path: `${OUT}/${tag}-mark-page.png` });
		let list = await bookmarkTexts();
		step(list.length === 1 && list[0].quote && list[0].t === `«${quote}»`, `${tag} закладка-цитата: в списке «цитата»`, JSON.stringify(list));
		await page.screenshot({ path: `${OUT}/${tag}-mark-list.png` });
		step(!(await hscroll(page)), `${tag} закладка-цитата: нет горизонтальной прокрутки`);
		await closeNav();
		await page.waitForTimeout(3500); // запись
		await page.reload();
		await page.waitForSelector(".pg-content span[data-w]", { timeout: 30000 });
		await page.waitForTimeout(700);
		const m2 = await marked();
		step(m2.length === 6 && m2[0] === w0, `${tag} закладка-цитата: после перезагрузки подсветка на месте`, m2.join(","));
		list = await bookmarkTexts();
		step(list.length === 1 && list[0].quote && list[0].t === `«${quote}»`, `${tag} закладка-цитата: после перезагрузки цитата на месте`);
		// удаление
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await page.waitForTimeout(200);
		await closeNav();
		step((await marked()).length === 0, `${tag} закладка-цитата: после удаления pg-mark нет`);
		// выделил, снял, в течение 1 с — закладка с цитатой
		const w1 = w0;
		const q2 = await select(w1, w1 + 2);
		await page.waitForTimeout(300);
		await page.evaluate(() => getSelection().removeAllRanges());
		await page.waitForTimeout(500);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(300);
		step((await marked()).length === 3, `${tag} закладка-цитата: выделение снято меньше секунды назад — закладка с цитатой`, String((await marked()).length));
		list = await bookmarkTexts();
		step(list.length === 1 && list[0].quote && list[0].t === `«${q2}»`, `${tag} закладка-цитата: в списке цитата`);
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await closeNav();
		// через 3 с — обычная
		await select(w1, w1 + 2);
		await page.waitForTimeout(200);
		await page.evaluate(() => getSelection().removeAllRanges());
		await page.waitForTimeout(3000);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(300);
		step((await marked()).length === 0 && (await page.textContent("#toast")) === "Закладка добавлена", `${tag} закладка-цитата: через 3 с после снятия — обычная закладка`);
		list = await bookmarkTexts();
		step(list.length === 1 && !list[0].quote && list[0].t.endsWith("…"), `${tag} закладка-цитата: обычная закладка в списке как раньше`, JSON.stringify(list));
		step(!(await hscroll(page)), `${tag} закладка-цитата: список без горизонтальной прокрутки`);
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await closeNav();

		// выделил, перелистнул, нажал значок: выделение ушло со страницей, закладка обычная
		await select(w1, w1 + 2);
		await page.waitForTimeout(150);
		await page.keyboard.press("ArrowRight");
		await settle(page);
		await page.waitForTimeout(150);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(300);
		step((await marked()).length === 0 && (await page.textContent("#toast")) === "Закладка добавлена", `${tag} закладка-цитата: после листания выделение не уходит в закладку`);
		list = await bookmarkTexts();
		step(list.length === 1 && !list[0].quote, `${tag} закладка-цитата: после листания закладка обычная`, JSON.stringify(list));
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await closeNav();

		// выделение вне текста книги касанию листать не мешает; выделение в книге мешает
		const clickRight = () =>
			page.evaluate(() => {
				const v = document.querySelector(".pg-viewport");
				const r = v.getBoundingClientRect();
				v.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width * 0.8, clientY: r.top + r.height / 2 }));
			});
		const nowNum = () => page.evaluate(() => Number(/стр\. (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "")?.[1]));
		await page.waitForTimeout(500);
		await page.evaluate(() => {
			const r = document.createRange();
			r.selectNodeContents(document.querySelector(".pg-foot"));
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
		});
		const nA = await nowNum();
		await clickRight();
		await settle(page);
		step((await nowNum()) === nA + 1, `${tag} выделение вне книги: касание листает`, `${nA} -> ${await nowNum()}`);
		await page.evaluate(() => getSelection().removeAllRanges());
		const wIn = await page.evaluate(() => Number(document.querySelector(".pg-content span[data-w]").dataset.w));
		await select(wIn, wIn);
		const nB = await nowNum();
		await clickRight();
		await settle(page);
		step((await nowNum()) === nB, `${tag} выделение в книге: касание не листает`, `${nB} -> ${await nowNum()}`);
		await page.evaluate(() => getSelection().removeAllRanges());

		// переход к закладке-цитате: у слова есть и here, и pg-mark, а фон вспышки — не фон цитаты
		await page.waitForTimeout(500);
		const wq = await page.evaluate(() => {
			const w = Number(document.querySelector("div.book").dataset.word);
			if (document.querySelector(`.pg-content span[data-w="${w + 2}"]`)) return w;
			return Math.max(...[...document.querySelectorAll(".pg-content span[data-w]")].map((e) => Number(e.dataset.w))) - 2;
		});
		await select(wq, wq + 2);
		await page.waitForTimeout(150);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(300);
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
		await settle(page);
		list = await bookmarkTexts();
		step(list.length === 1 && list[0].quote, `${tag} переход к цитате: закладка-цитата в списке`, JSON.stringify(list));
		await page.click(".sheet-backdrop .mark-go");
		await page.waitForTimeout(250);
		const jump = await page.evaluate((w) => {
			const el = document.querySelector(`.pg-content span[data-w="${w}"]`);
			const other = document.querySelector(`.pg-content span[data-w="${w + 1}"]`);
			if (!el || !other) return null;
			return { here: el.classList.contains("here"), mark: el.classList.contains("pg-mark"), bg: getComputedStyle(el).backgroundColor, markBg: getComputedStyle(other).backgroundColor };
		}, wq);
		await page.screenshot({ path: `${OUT}/${tag}-mark-jump.png` });
		step(!!jump && jump.here && jump.mark && jump.bg !== jump.markBg, `${tag} переход к цитате: here и pg-mark вместе, фон вспышки виден`, JSON.stringify(jump));
		await page.waitForTimeout(1600);
		await bookmarkTexts();
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await closeNav();
	} catch (e) {
		step(false, `${tag} закладка-цитата: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-mark-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

console.log(`# ${BROWSER}, книга ${basename(BOOK)}, ${base}, снимки в ${OUT}`);
for (const [W, H] of SIZES) {
	const tag = `${BROWSER}-${bookName}-${W}x${H}`;
	console.log(`## ${W}x${H}`);
	await (IMG ? imgFlow : browserFlow)(W, H, tag);
	if (!IMG) await searchFlow(W, H, tag);
	await pageNumberFlow(W, H, tag);
	await ticksFlow(W, H, tag);
	if (!IMG) await animFlow(W, H, tag);
	await markFlow(W, H, tag);
	if (BROWSER === "chromium") await folderFlow(W, H, tag);
	else console.log("SKIP режим папки: в WebKit нет showDirectoryPicker, запись в OPFS в Safari только из воркера");
}
await browser.close();
stopServer();
console.log(failed ? `ИТОГ: провалов ${failed}` : "ИТОГ: всё прошло");
process.exit(failed ? 1 : 0);
