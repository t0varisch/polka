// Сквозная проверка Полки: режим браузера (импорт, страницы, по слову, печать, страницы, перезагрузка)
// и режим папки (?testfolder, только chromium).
// Сначала `npm run build`: скрипт без BASE сам поднимает `vite preview` на собранном dist/.
// Рисунки: IMG_BOOK=путь.fb2 вместо BOOK — сценарий с рисунками на страницах и просмотром на весь экран.
// Запуск: BOOK=путь.fb2 [SIZES=390x844,320x640,1280x800] [BROWSER=chromium|webkit] [BASE=http://...] [OUT=test-output] node scripts/e2e.mjs
// Поиск по книге (searchFlow) идёт в сценарии BOOK=, не в IMG_BOOK.
// «Страницы» — одна лента на любом устройстве: ribbonFlow (BOOK=) и ribbonImgFlow (IMG_BOOK=) смотрят на неё вблизи, остальные сценарии идут сквозь неё.
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

// Контекст без настроек: «Страницы» всегда лента
const newCtx = (opts) => browser.newContext(opts);

const dw = (p) => p.evaluate(() => Number(document.querySelector("div.book").dataset.word));
const dm = (p) => p.evaluate(() => document.querySelector("div.book").dataset.mode);
// Слово-место стоит верхней строкой окна (после переноса строк оно может быть не первым в строке) или это первое слово верхней строки
const onOpenPage = async (p) => {
	const w = await dw(p);
	return (await rbWordOnTop(p, w)) || (await rbMetrics(p)).top?.word === w || (await rbFigTopWord(p)) === w;
};
// Экран, где наверху рисунок (целой строки текста выше него нет): место — первое слово после рисунка (слово, перед абзацем которого он стоит)
const rbFigTopWord = (p) =>
	p.evaluate(() => {
		const win = document.querySelector(".rb-window");
		const wr = win.getBoundingClientRect();
		const lh = parseFloat(getComputedStyle(document.querySelector(".rb-content")).lineHeight);
		const els = [...win.querySelectorAll("figure, span[data-w]")].filter((e) => !e.closest("figure") || e.tagName === "FIGURE");
		const topOf = (e) => {
			const r = e.getClientRects()[0];
			return e.tagName === "FIGURE" ? r.top : (r.top + r.bottom) / 2 - lh / 2;
		};
		const first = els.filter((e) => topOf(e) >= wr.top - 1.5).sort((a, b) => topOf(a) - topOf(b))[0];
		if (!first || first.tagName !== "FIGURE") return null;
		const next = els.find((e) => e.tagName !== "FIGURE" && first.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
		return next ? Number(next.dataset.w) : null;
	});
// Место сохранилось после перекладки текста: слово w на верхней строке или место — первое слово верхней видимой строки, не дальше строки перед w
const spotKept = async (p, w) => {
	const d = await dw(p);
	return d <= w && w - d < 40 && ((await rbWordOnTop(p, w)) || (await rbMetrics(p)).top?.word === d);
};
// Рисунок, который виден в окне ленты (по вертикали пересекает окно); целиком видимый — вперёд
const figInfo = (p) =>
	p.evaluate(() => {
		const vp = document.querySelector(".rb-window").getBoundingClientRect();
		const inside = (r) => r.left >= vp.left - 1 && r.right <= vp.right + 1 && r.top >= vp.top - 1 && r.bottom <= vp.bottom + 1;
		const seen = [];
		for (const img of document.querySelectorAll(".rb-window img.pg-img")) {
			const r = img.getBoundingClientRect();
			if (r.bottom <= vp.top + 1 || r.top >= vp.bottom - 1) continue;
			const cap = img.closest("figure")?.querySelector(".pg-cap");
			const cr = cap?.getBoundingClientRect();
			const body = document.querySelector(".pg-content p:not(.pg-cap)");
			seen.push({
				i: img.dataset.i,
				ok: img.complete && img.naturalWidth > 0,
				inside: inside(r) && (!cr || inside(cr)),
				cap: cap ? cap.textContent : null,
				capTag: cap ? cap.tagName : null,
				capInside: cr ? inside(cr) : null,
				capFont: cap ? getComputedStyle(cap).fontFamily : null,
				bodyFont: body ? getComputedStyle(body).fontFamily : null,
				box: [Math.round(r.width), Math.round(r.height)],
			});
		}
		return seen.find((f) => f.inside) ?? seen[0] ?? null;
	});
// Экран вперёд клавишей и ждём конца плавной прокрутки
const nextScreen = async (p) => {
	await p.keyboard.press("ArrowRight");
	await rbSettle(p);
};
const settle = (p) => rbSettle(p);
const hscroll = (p) => p.evaluate(() => document.documentElement.scrollWidth > innerWidth);

async function toMode(page, m, ready) {
	if ((await dm(page)) !== m) await page.click(`[data-m="${m}"]`);
	await page.waitForSelector(ready, { timeout: 30000 });
	await page.waitForTimeout(500);
}

async function browserFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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

		for (let i = 0; i < 3; i++) await nextScreen(page);
		const w3 = await dw(page);
		step(w3 > w0 && (await onOpenPage(page)), `${tag} браузер: вперёд 3 экрана`, `${w0} -> ${w3}`);
		await shot("2-pages-forward3");

		// смена размера окна и размера текста: слово-якорь остаётся на открытой странице
		const alt = W >= 800 ? [390, 844] : [W === 390 ? 1280 : 1100, 700];
		await page.setViewportSize({ width: alt[0], height: alt[1] });
		await page.waitForTimeout(900);
		step(await spotKept(page, w3), `${tag} браузер: смена окна на ${alt[0]}x${alt[1]}, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2a-resized");
		await page.setViewportSize({ width: W, height: H });
		await page.waitForTimeout(900);
		step(await spotKept(page, w3), `${tag} браузер: окно вернули, слово на странице`, `${w3} -> ${await dw(page)}`);
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		const size = page.locator('.sheet-backdrop input[aria-label="Размер текста"]');
		const size0 = await size.inputValue();
		await size.fill("30");
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step(await spotKept(page, w3), `${tag} браузер: размер текста ${size0} -> 30 px, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2b-font-30");
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		await page.locator('.sheet-backdrop input[aria-label="Размер текста"]').fill("14");
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step(await spotKept(page, w3), `${tag} браузер: размер текста 14 px, слово на странице`, `${w3} -> ${await dw(page)}`);
		await shot("2c-font-14");
		await page.click('[aria-label="Настройки"]');
		await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		await page.locator('.sheet-backdrop input[aria-label="Размер текста"]').fill(size0);
		await page.waitForTimeout(700);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(700);
		step(await spotKept(page, w3), `${tag} браузер: размер текста вернули (${size0} px), слово на странице`, `${w3} -> ${await dw(page)}`);

		const w3b = await dw(page);
		await toMode(page, "words", ".mode-words .word .p");
		step((await dw(page)) === w3b, `${tag} браузер: «По слову» то же слово`, `${await dw(page)} == ${w3b}`);
		await shot("3-words");
		await page.click(".play");
		await page.waitForTimeout(2000);
		await page.click(".play");
		await page.waitForTimeout(400);
		const wp = await dw(page);
		step(wp > w3b, `${tag} браузер: пуск на 2 с продвинул слово`, `${w3b} -> ${wp}`);
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

// Листает вперёд до экрана с рисунком (у chipolla — с подписью «Рис.»), не больше 300 экранов; рисунок и подпись видны целиком
async function findFigPage(page) {
	const want = bookName === "chipolla" ? (f) => f.cap && f.cap.includes("Рис.") : () => true;
	let stuck = 0;
	for (let n = 0; n < 300; n++) {
		const f = await figInfo(page);
		if (f && f.inside && want(f)) return f;
		const w = await dw(page);
		await nextScreen(page);
		stuck = (await dw(page)) === w && !(await figInfo(page)) ? stuck + 1 : 0;
		if (stuck >= 3) break;
	}
	return null;
}
// Экран из одних рисунков: рисунок виден, ни одного слова текста (не подписи) в окне нет
const wordsVisible = (p) =>
	p.evaluate(() => {
		const vp = document.querySelector(".rb-window").getBoundingClientRect();
		return [...document.querySelectorAll(".rb-window span[data-w]")].some((s) => {
			if (s.closest("figure")) return false;
			const r = s.getBoundingClientRect();
			return r.bottom > vp.top + 1 && r.top < vp.bottom - 1;
		});
	});
async function findImageOnlyPage(page) {
	let stuck = 0;
	for (let n = 0; n < 300; n++) {
		const f = await figInfo(page);
		if (f && !(await wordsVisible(page))) return f;
		const w = await dw(page);
		await nextScreen(page);
		stuck = (await dw(page)) === w && !(await figInfo(page)) ? stuck + 1 : 0;
		if (stuck >= 3) break;
	}
	return null;
}
const imgSel = (i) => 'img.pg-img[data-i="' + i + '"]';

async function imgFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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
		step(f0.ok && f0.inside, `${tag} рисунки: загружен, целиком в окне ленты`, JSON.stringify(f0.box));
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
		step(!(await page.$(".pg-viewer")) && (await dw(page)) === w0 && !!f1 && f1.i === f0.i, `${tag} рисунки: нажатие закрыло просмотр, слово и экран те же`);
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
		step(n2 > 0 && (!f2 || f2.ok) && (await dw(page)) === w0, `${tag} рисунки: смена окна на ${alt[0]}x${alt[1]}, слово то же, рисунок загружен`, f2 ? `виден ${f2.i}` : "рисунок на соседней странице");
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

		// 6. экран из одних рисунков: после смены окна в ленте тот же рисунок
		{
			const fo = await findImageOnlyPage(page);
			if (fo) {
				const wfo = await dw(page);
				await page.setViewportSize({ width: alt[0], height: alt[1] });
				await page.waitForTimeout(1000);
				const fo2 = await page.evaluate((i) => {
					const im = document.querySelector(`.rb-window img.pg-img[data-i="${i}"]`);
					return im ? { ok: im.complete && im.naturalWidth > 0, w: Math.round(im.getBoundingClientRect().width) } : null;
				}, fo.i);
				step(!!fo2 && fo2.ok && fo2.w <= alt[0] && (await dw(page)) === wfo, `${tag} рисунки: экран из одних рисунков, смена окна на ${alt[0]}x${alt[1]} — тот же рисунок ${fo.i} в ленте, слово то же`, fo2 ? `ширина ${fo2.w}` : "рисунка в ленте нет");
				await shot("3a-image-only-resized");
				await page.setViewportSize({ width: W, height: H });
				await page.waitForTimeout(1000);
			} else step(bookName !== "buzunov", `${tag} рисунки: экран из одних рисунков`, bookName === "buzunov" ? "не найден за 300 экранов" : "в этой книге не найдена, шаг пропущен");
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
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	const num = () =>
		page.evaluate(() => {
			const m = /стр\. (\d+) из (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "");
			return m ? [Number(m[1]), Number(m[2])] : null;
		});
	// Кусок (глава), в котором стоит верхняя строка окна
	const chunkKey = async () => String((await rbMetrics(page)).top?.chunk ?? "");
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
				await rbSettle(page);
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
			await nextScreen(page);
			if ((await chunkKey()) !== k0) found = true;
		}
		if (!step(found, `${tag} номера: найдена граница куска`)) throw new Error("нет границы куска");
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowLeft");
			await rbSettle(page);
		}
		let prev = await num();
		let prevKey = await chunkKey();
		const seq = [prev];
		const keys = [prevKey];
		let ok = true;
		let crossed = 0;
		for (let i = 0; i < 6; i++) {
			await nextScreen(page);
			const cur = await num();
			const key = await chunkKey();
			seq.push(cur);
			keys.push(key);
			// номер растёт ровно на 1 при каждом листании вперёд, в том числе через границу куска
			const d = cur && prev ? cur[0] - prev[0] : -1;
			if (key !== prevKey) crossed++;
			if (d !== 1) ok = false;
			prev = cur;
			prevKey = key;
		}
		step(crossed >= 1, `${tag} номера: в шести экранах есть граница куска`, String(crossed));
		const a = seq[seq.length - 1];
		const b = seq[seq.length - 2];
		step(ok, `${tag} номера: шесть экранов вперёд через границу — каждый раз ровно +1`, seq.map((x, i) => `${x?.join("/")}@${keys[i]}`).join(" "));
		// назад по стеку верхов — ровно -1 на каждом экране, в том числе через границу
		let back = true;
		const seqBack = [a];
		for (let i = 0; i < 6; i++) {
			const before = await num();
			await page.keyboard.press("ArrowLeft");
			await rbSettle(page);
			const cur = await num();
			seqBack.push(cur);
			if (!before || !cur || before[0] - cur[0] !== 1) back = false;
		}
		step(back, `${tag} номера: шесть экранов назад — каждый раз ровно -1`, seqBack.map((x) => x?.join("/")).join(" "));
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
		step(!!last && last[1] === last[0], `${tag} номера: на последнем слове книги — «M из M»`, JSON.stringify(last));
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
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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
				step((await onOpenPage(page)) && t.toLowerCase().replace(/ё/g, "е").includes(first3), `${tag} поиск [pages]: слово совпадения — верхняя строка окна`, t);
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
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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
		for (let i = 0; i < 3; i++) await nextScreen(page);
		const w3 = await dw(page);
		step(w3 > w0, `${tag} папка: вперёд 3 экрана`, `${w0} -> ${w3}`);
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
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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

// Листание на экран: клавиши подряд, свайп (Chromium), граница куска, палец вертикально, «уменьшить движение»
async function screenFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} ошибка страницы`, e.message));
	const chunkKey = async () => String((await rbMetrics(page)).top?.chunk ?? "");
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
	// Палец: от точки from на (dx, dy) пикселей за steps шагов, потом отпускание
	const swipe = async (dx, { dy = 0, steps = 6, stepMs = 16, y = Math.round(H / 2), from = Math.round(W / 2) } = {}) => {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
		for (let i = 1; i <= steps; i++) {
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + Math.round((dx * i) / steps), y: y + Math.round((dy * i) / steps) }] });
			await page.waitForTimeout(stepMs);
		}
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await rbSettle(page);
	};
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(page, "pages", ".pg-content span[data-w]");
		await seekSlider(300);

		// касание правой части: верх встал на строку, что не влезла, место — верхнее слово, номер +1
		const n0 = await rbNum(page);
		const w0 = await dw(page);
		const m0 = await rbMetrics(page);
		await rbTap(page, "right");
		const m1 = await rbMetrics(page);
		step(Math.abs(m1.st - m0.nextTop) <= 1.2, `${tag} листание: касание — верх на строке, что не влезла`, `${m0.st} -> ${m1.st}, ждали ${m0.nextTop}`);
		step((await dw(page)) > w0 && (await onOpenPage(page)) && (await rbNum(page)) > n0 && (await rbNum(page)) <= n0 + 2, `${tag} листание: место — верхнее слово нового экрана, номер растёт`, `слово ${w0} -> ${await dw(page)}, номер ${n0} -> ${await rbNum(page)}`);

		// клавиши подряд без ожидания: цель продолжается от цели идущей прокрутки — туда же, куда три по одной
		const top = async () => (await rbMetrics(page)).topId;
		const sBase = await top();
		for (let i = 0; i < 3; i++) await nextScreen(page);
		const sThree = await top();
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowLeft");
			await rbSettle(page);
		}
		step((await top()) === sBase, `${tag} листание: три экрана вперёд и три назад по одному — на прежнем месте`, `${sBase} -> ${await top()}`);
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(30);
		}
		await rbSettle(page);
		step((await top()) === sThree && (await onOpenPage(page)), `${tag} листание: три клавиши вперёд подряд — туда же, куда три по одной`, `${sThree} ждали, ${await top()}`);
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("ArrowLeft");
			await page.waitForTimeout(30);
		}
		await rbSettle(page);
		step((await top()) === sBase && (await onOpenPage(page)), `${tag} листание: три клавиши назад подряд — на прежний экран`, `${sBase} ждали, ${await top()}`);
		// по строке: стрелка вниз и вверх возвращает на ту же строку
		const lTop = await rbMetrics(page);
		await page.keyboard.press("ArrowDown");
		await rbSettle(page);
		const lDown = await rbMetrics(page);
		await page.keyboard.press("ArrowUp");
		await rbSettle(page);
		const lUp = await rbMetrics(page);
		step(lDown.topId !== lTop.topId && lUp.topId === lTop.topId, `${tag} листание: стрелка вниз — одна строка, вверх — обратно`, `${lTop.topId} -> ${lDown.topId} -> ${lUp.topId}`);
		// Shift+пробел — экран назад, пробел — вперёд
		await page.keyboard.press("Space");
		await rbSettle(page);
		const sSp = await top();
		await page.keyboard.press("Shift+Space");
		await rbSettle(page);
		step(sSp !== sBase && (await top()) === sBase, `${tag} листание: пробел — экран вперёд, Shift+пробел — назад`, `${sBase} -> ${sSp} -> ${await top()}`);

		if (cdp) {
			// свайп: короткий (30 px) экран не листает, 120 px листает, обратный возвращает
			const n3 = await rbNum(page);
			const sa = await rbScroll(page);
			await swipe(-30, { steps: 5, stepMs: 20 });
			step((await rbNum(page)) === n3 && Math.abs((await rbScroll(page)) - sa) < 1.2, `${tag} свайп: 30 px — экран тот же`, `${n3} -> ${await rbNum(page)}`);
			await swipe(-120, { steps: 6, stepMs: 25 });
			step((await rbNum(page)) === n3 + 1 && (await onOpenPage(page)), `${tag} свайп: 120 px влево — следующий экран`, `${n3} -> ${await rbNum(page)}`);
			await swipe(120, { steps: 6, stepMs: 25 });
			step((await rbNum(page)) === n3 && (await onOpenPage(page)), `${tag} свайп: вправо 120 px — назад`, `-> ${await rbNum(page)}`);
			// быстрый рывок короче порога листает
			await swipe(-38, { steps: 1, stepMs: 0 });
			await rbSettle(page);
			step((await rbNum(page)) === n3 + 1 && (await onOpenPage(page)), `${tag} свайп: быстрый рывок на 38 px — листает`, `${n3} -> ${await rbNum(page)}`);
			await swipe(120, { steps: 6, stepMs: 25 });
			await rbSettle(page);
			// палец вверх-вниз двигает ленту вслед за собой, место — верхняя строка
			const sv = await rbScroll(page);
			await swipe(0, { dy: -90, steps: 6, stepMs: 25 });
			await page.waitForTimeout(300);
			const sv1 = await rbScroll(page);
			step(sv1 - sv > 30 && (await onOpenPage(page)), `${tag} палец: вверх на 90 px — лента сдвинулась`, `${sv} -> ${sv1}`);
			await swipe(0, { dy: 90, steps: 6, stepMs: 25 });
			step((await rbScroll(page)) < sv1 - 30, `${tag} палец: вниз на 90 px — лента вернулась`, `${sv1} -> ${await rbScroll(page)}`);
		}

		// граница куска: последний экран главы, дальше следующая; номер идёт на 1
		await page.evaluate(() => {
			const win = document.querySelector(".rb-window");
			const first = win.querySelector("section.rb-chunk");
			win.scrollTop = first.offsetTop + first.offsetHeight - 3 * win.clientHeight;
		});
		await rbSettle(page);
		const k0 = await chunkKey();
		let found = false;
		for (let i = 0; i < 12 && !found; i++) {
			await nextScreen(page);
			if ((await chunkKey()) !== k0) found = true;
		}
		if (!step(found, `${tag} листание: найдена граница куска`)) throw new Error("нет границы куска");
		await page.keyboard.press("ArrowLeft");
		await rbSettle(page);
		const nb = await rbNum(page);
		const kb = await chunkKey();
		if (cdp) {
			await swipe(-120, { steps: 6, stepMs: 25 });
			step((await chunkKey()) !== kb && (await rbNum(page)) - nb === 1 && (await onOpenPage(page)), `${tag} свайп: через границу куска — следующая глава, номер ровно +1`, `${nb} -> ${await rbNum(page)}`);
			await swipe(120, { steps: 6, stepMs: 25 });
			step((await chunkKey()) === kb && (await rbNum(page)) === nb && (await onOpenPage(page)), `${tag} свайп: обратно в прежнюю главу, номер -1`, `-> ${await rbNum(page)}`);
		}
		await nextScreen(page);
		step((await chunkKey()) !== kb && (await rbNum(page)) - nb === 1 && (await onOpenPage(page)), `${tag} листание: клавиша через границу — следующая глава, номер ровно +1`, `${nb} -> ${await rbNum(page)}`);
		await page.screenshot({ path: `${OUT}/${tag}-screen-end.png` });
		step(!(await hscroll(page)), `${tag} листание: нет горизонтальной прокрутки`);
	} catch (e) {
		step(false, `${tag} листание: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-screen-ERROR.png` }).catch(() => {});
	}
	await ctx.close();

	// «уменьшить движение»: экран встаёт на место сразу, свайп листает так же
	const ctx2 = await newCtx({ viewport: { width: W, height: H }, hasTouch: true, reducedMotion: "reduce" });
	const p2 = await ctx2.newPage();
	try {
		await p2.goto(base);
		await p2.waitForSelector(".library .actions");
		await p2.setInputFiles('input[type="file"]', BOOK);
		await p2.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(p2, "pages", ".rb-window span[data-w]");
		await p2.waitForTimeout(400);
		const m = await rbMetrics(p2);
		await p2.keyboard.press("ArrowRight");
		await p2.waitForTimeout(40);
		const st = await rbScroll(p2);
		step(Math.abs(st - m.nextTop) <= 1.2, `${tag} reduced-motion: экран встал на место сразу, без плавной прокрутки`, `${m.st} -> ${st}, ждали ${m.nextTop}`);
		await p2.keyboard.press("ArrowLeft");
		await p2.waitForTimeout(40);
		step(Math.abs((await rbScroll(p2)) - m.st) <= 1.2, `${tag} reduced-motion: назад — на прежний экран сразу`, `${await rbScroll(p2)} ждали ${m.st}`);
		if (BROWSER === "chromium") {
			const c2 = await ctx2.newCDPSession(p2);
			const m3 = await rbMetrics(p2);
			const s0 = await rbScroll(p2);
			const y = Math.round(H / 2);
			await c2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(W / 2), y }] });
			await c2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(W / 2) - 80, y }] });
			await c2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await p2.waitForTimeout(100);
			step(Math.abs((await rbScroll(p2)) - m3.nextTop) <= 1.2 && m3.nextTop > s0 + 1, `${tag} reduced-motion: свайп листает сразу`, `${s0} -> ${await rbScroll(p2)}, ждали ${m3.nextTop}`);
		}
	} catch (e) {
		step(false, `${tag} reduced-motion: сценарий оборвался`, String(e.message).split("\n")[0]);
	}
	await ctx2.close();
}

// Закладка из выделенного текста: цитата в списке, подсветка pg-mark, выделение снято — закладка с цитатой ещё 2 с
async function markFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
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
		for (let i = 0; i < 3; i++) await nextScreen(page);
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
				const v = document.querySelector(".rb-window");
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
		const sA = await rbScroll(page);
		await clickRight();
		await settle(page);
		step((await nowNum()) === nA + 1, `${tag} выделение вне книги: касание листает`, `${nA} -> ${await nowNum()}, прокрутка ${sA} -> ${await rbScroll(page)}`);
		await page.evaluate(() => getSelection().removeAllRanges());
		const wIn = await dw(page);
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
		for (let i = 0; i < 3; i++) await nextScreen(page);
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

// ---- Лента (раскладка «Страниц» для пальца)
const rbScroll = (p) => p.evaluate(() => document.querySelector(".rb-window").scrollTop);
// Ждёт, пока лента сама доложит, что своей плавной прокрутки нет (data-settled="1" на окне), и прокрутка постоит на месте 200 мс:
// плавная прокрутка — не CSS-анимация, settle её не видит, а одной неподвижности мало: WebKit мог ещё не начать
async function rbSettle(p) {
	let last = -1e9;
	let still = 0;
	for (let i = 0; i < 160 && still < 4; i++) {
		const t = await rbScroll(p);
		const settled = await p.evaluate(() => document.querySelector(".rb-window").dataset.settled === "1");
		still = settled && Math.abs(t - last) < 0.5 ? still + 1 : 0;
		last = t;
		await p.waitForTimeout(50);
	}
	await p.waitForTimeout(250); // пауза «дальний кусок убирается»
}
// Строки и рисунки окна ленты в порядке чтения: строка — по центру первого слова, подпись рисунка — часть рисунка.
// id строки — её первое слово, id рисунка — его номер: по ним проверяем место, не завися от координат (убранный сверху кусок их сдвигает)
const rbItems = (p) =>
	p.evaluate(() => {
		const win = document.querySelector(".rb-window");
		const wr = win.getBoundingClientRect();
		const lh = parseFloat(getComputedStyle(document.querySelector(".rb-content")).lineHeight);
		const items = [];
		for (const fg of win.querySelectorAll("figure")) {
			const r = fg.getBoundingClientRect();
			items.push({ top: r.top, bottom: r.bottom, id: "f" + fg.querySelector("img").dataset.i, fig: true });
		}
		let lastTop = -1e9;
		let lastSec = null;
		for (const sp of win.querySelectorAll("span[data-w]")) {
			if (sp.closest("figure")) continue;
			const r = sp.getClientRects()[0]; // слово с переносом по дефису — первая строка
			const mid = (r.top + r.bottom) / 2;
			const sec = sp.closest("section");
			// слова одной строки (центр в пределах 5 px) — одна строка
			if (sp.parentElement === lastSec && Math.abs(mid - lastTop) <= 5) continue;
			lastTop = mid;
			lastSec = sp.parentElement;
			items.push({ top: mid - lh / 2, bottom: mid + lh / 2, id: "w" + sp.dataset.w, word: Number(sp.dataset.w), chunk: Number(sec.dataset.i) });
		}
		items.sort((a, b) => a.top - b.top);
		return { items, wr: { top: wr.top, bottom: wr.bottom, left: wr.left, width: wr.width, height: wr.height }, lh, st: win.scrollTop, sections: win.querySelectorAll("section.rb-chunk").length };
	});
const rbMetrics = async (p) => {
	const { items, wr, lh, st, sections } = await rbItems(p);
	const top = items.find((it) => !it.fig && it.top >= wr.top - 1.5 && it.bottom <= wr.bottom + 1.5);
	const first = items.find((it) => it.top >= wr.top - 1.5);
	const nx = items.find((it) => it.bottom > wr.bottom + 0.5 && it.top > wr.top + 0.5);
	return {
		top: top ? { word: top.word, chunk: top.chunk } : null,
		topId: first?.id,
		topOff: first ? first.top - wr.top : null, // верхняя строка вровень с краем окна
		nextId: nx?.id,
		H: wr.height,
		y: wr.top,
		x: wr.left,
		w: wr.width,
		lh,
		st,
		nextTop: nx ? st + (nx.top - wr.top) : null,
		sections,
	};
};
// Верхи строк и рисунков в координатах содержимого окна
const rbLines = async (p) => {
	const { items, wr, st } = await rbItems(p);
	return items.map((it) => ({ top: st + it.top - wr.top, id: it.id }));
};
// Слово w стоит в верхней строке окна (строка видна целиком, верх ±1.5 px)
const rbWordOnTop = (p, w) =>
	p.evaluate((w) => {
		const win = document.querySelector(".rb-window");
		const wr = win.getBoundingClientRect();
		const lh = parseFloat(getComputedStyle(document.querySelector(".rb-content")).lineHeight);
		const sp = win.querySelector(`span[data-w="${w}"]`);
		if (!sp) return false;
		const r = sp.getClientRects()[0];
		const top = (r.top + r.bottom) / 2 - lh / 2;
		return Math.abs(top - wr.top) <= 1.5;
	}, w);
// Низ экрана: строка (или рисунок), что пересекает нижний край окна, закрыта шторкой цвета страницы целиком; последняя целая строка открыта.
// need = false — снизу ничего не обрезано, проверять нечего
const rbBottomCheck = async (p) => {
	const { items, wr } = await rbItems(p);
	const cur = await p.evaluate(() => {
		const c = document.querySelector(".rb-curtain");
		const w = document.querySelector(".rb-window");
		if (!c) return null;
		const r = c.getBoundingClientRect();
		const cs = getComputedStyle(c);
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, shown: cs.display !== "none" && cs.visibility !== "hidden" && r.height > 0, bg: cs.backgroundColor, inner: w.clientWidth, wl: w.getBoundingClientRect().left };
	});
	const full = items.filter((it) => it.top >= wr.top - 1.5 && it.bottom <= wr.bottom + 1.5);
	const lastFull = full[full.length - 1];
	const part = items.find((it) => it.top < wr.bottom - 1 && it.bottom > wr.bottom + 1.5);
	if (!part) return { need: false, ok: true, info: "" };
	const ok =
		!!cur &&
		cur.shown &&
		cur.top <= part.top + 1 &&
		cur.bottom >= wr.bottom - 1 &&
		(!lastFull || cur.top >= lastFull.bottom - 1.5) &&
		cur.left <= cur.wl + 1 &&
		cur.right >= cur.wl + cur.inner - 1 &&
		!/rgba\(0, 0, 0, 0\)|transparent/.test(cur.bg);
	const r1 = (v) => (v == null ? null : +v.toFixed(1));
	return {
		need: true,
		ok,
		info: JSON.stringify({ part: part.id, partTop: r1(part.top - wr.top), lastBottom: lastFull ? r1(lastFull.bottom - wr.top) : null, H: r1(wr.height), cur: cur && { top: r1(cur.top - wr.top), bottom: r1(cur.bottom - wr.top), shown: cur.shown, bg: cur.bg } }),
	};
};
const rbNum = (p) => p.evaluate(() => Number(/стр\. (\d+) из (\d+)/.exec(document.querySelector(".pg-foot")?.textContent ?? "")?.[1]));
// Касание по рисунку открывает просмотр, а не листает: точку берём там, где рисунка нет
const rbTap = async (p, side) => {
	const m = await rbMetrics(p);
	const x = m.x + m.w * (side === "right" ? 0.8 : 0.15);
	const y = await p.evaluate(
		([x, y0, h]) => {
			for (const k of [0.5, 0.15, 0.85, 0.3, 0.7, 0.05, 0.95]) {
				const el = document.elementFromPoint(x, y0 + h * k);
				if (el && !el.closest("img.pg-img")) return y0 + h * k;
			}
			return y0 + h / 2;
		},
		[x, m.y, m.H],
	);
	await p.touchscreen.tap(x, y);
	await rbSettle(p);
};
async function openRibbon(page, ready = ".rb-window span[data-w]") {
	await toMode(page, "pages", ready);
	await page.waitForTimeout(400);
}

async function ribbonFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-ribbon-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} лента: ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} лента: ошибка в консоли`, m.text()));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await openRibbon(page);
		step(!!(await page.$(".mode-ribbon .rb-window")) && !(await page.$(".pg-viewport")), `${tag} лента: открыта, колонок нет`);
		step(!(await hscroll(page)), `${tag} лента: нет горизонтальной прокрутки`);
		const m0 = await rbMetrics(page);
		step(m0.st === 0 && (await onOpenPage(page)) && (await rbNum(page)) === 1, `${tag} лента: начало книги, страница 1`, JSON.stringify({ st: m0.st, top: m0.top, n: await rbNum(page) }));
		await shot("1-start");

		// прокрутка на полтора экрана: место сдвинулось, верхнее слово видно целиком
		const w0 = await dw(page);
		await page.evaluate((h) => document.querySelector(".rb-window").scrollBy(0, h * 1.5), m0.H);
		await rbSettle(page);
		const m1 = await rbMetrics(page);
		const w1 = await dw(page);
		step(w1 > w0 && m1.top?.word === w1, `${tag} лента: прокрутка на 1,5 экрана, место вперёд, верхнее слово видно целиком`, `${w0} -> ${w1}, верх ${m1.top?.word}`);
		await shot("2-mid");

		// касание справа: новый верх = низ прежней последней целой строки; слева — прежний верх
		await rbTap(page, "right");
		const m2 = await rbMetrics(page);
		step(Math.abs(m2.st - m1.nextTop) <= 1.2, `${tag} лента: касание справа — верх на строке, что не влезла`, `${m1.st} -> ${m2.st}, ждали ${m1.nextTop?.toFixed(1)}`);
		step(m2.top?.word === (await dw(page)) && (await dw(page)) > w1, `${tag} лента: после касания место — верхнее слово`, `${w1} -> ${await dw(page)}`);
		await shot("3-after-tap");
		await rbTap(page, "left");
		const m3 = await rbMetrics(page);
		step(Math.abs(m3.st - m1.st) <= 1.2, `${tag} лента: касание слева — прежний верх`, `${m2.st} -> ${m3.st}, был ${m1.st}`);

		// клавиши: вперёд (пробел, PageDown, →) и назад (←, PageUp); экран узнаём по строке, что не влезла
		let prev = m3;
		let ok = true;
		const bottoms = [];
		for (const key of ["Space", "PageDown", "ArrowRight"]) {
			await page.keyboard.press(key);
			await rbSettle(page);
			const m = await rbMetrics(page);
			ok = ok && m.topId === prev.nextId;
			prev = m;
			bottoms.push(await rbBottomCheck(page));
		}
		step(ok, `${tag} лента: клавиши Пробел, PageDown, → листают на экран`, `верх ${prev.topId}`);
		let mb = null;
		for (const key of ["ArrowLeft", "PageUp", "ArrowLeft"]) {
			await page.keyboard.press(key);
			await rbSettle(page);
			mb = await rbMetrics(page);
			bottoms.push(await rbBottomCheck(page));
		}
		step(mb.topId === m3.topId, `${tag} лента: три раза назад — на исходный экран`, `${mb.topId} ждали ${m3.topId}`);
		const cut = bottoms.filter((b) => b.need);
		step(cut.every((b) => b.ok), `${tag} лента: внизу экрана нет обрезанной строки — та, что не влезла, закрыта целиком, целые открыты`, `проверено экранов ${cut.length} из ${bottoms.length}; ${cut.filter((b) => !b.ok).map((b) => b.info).join(" | ")}`);

		// колесо мыши: одна засечка — одна строка; мелкая дельта (тачпад) копится до строки
		await page.mouse.move(m0.x + m0.w / 2, m0.y + m0.H / 2);
		await page.evaluate(() => document.querySelector(".rb-window").scrollBy(0, 4000)); // в плотный текст: у начала книги строки перемежаются рисунками
		await rbSettle(page);
		const topIdAfter = async () => (await rbMetrics(page)).topId;
		const nextLines = async () => {
			const st = (await rbMetrics(page)).st;
			const lt = await rbLines(page);
			const i = lt.findIndex((l) => l.top > st + 1);
			return lt.slice(i);
		};
		const L = await nextLines(); // L[0] — следующая строка после текущего верха
		for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
		await rbSettle(page);
		const id1 = await topIdAfter();
		step(id1 === L[2].id, `${tag} лента: колесо вниз 3 раза — ровно три строки`, `верх ${id1}, ждали ${L[2].id}`);
		await page.mouse.wheel(0, -100);
		await rbSettle(page);
		const id2 = await topIdAfter();
		step(id2 === L[1].id, `${tag} лента: колесо вверх — одна строка назад`, `верх ${id2}, ждали ${L[1].id}`);
		const L2 = await nextLines();
		for (let i = 0; i < 2; i++) await page.mouse.wheel(0, 10);
		await page.waitForTimeout(100);
		const stMid = (await rbMetrics(page)).st;
		await rbSettle(page);
		step((await topIdAfter()) === id2, `${tag} лента: две мелкие дельты (20 px) — строка ещё не набралась`, `${stMid}`);
		// пауза выше сбросила набранное (так задумано: палец остановился — счёт заново);
		// теперь шлём по 10 px без пауз, пока сумма не дотянет до высоты строки — при любом шрифте
		const lhNow = (await rbMetrics(page)).lh;
		const nSmall = Math.ceil(lhNow / 10);
		for (let i = 0; i < nSmall; i++) await page.mouse.wheel(0, 10);
		await rbSettle(page);
		const id3 = await topIdAfter();
		step(id3 === L2[0].id, `${tag} лента: мелкие дельты до высоты строки — одна строка`, `${nSmall}×10 px при строке ${lhNow.toFixed(2)}, верх ${id3}, ждали ${L2[0].id}`);
		// стрелки вверх и вниз — по строке
		const L3 = await nextLines();
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
		await rbSettle(page);
		const id4 = await topIdAfter();
		step(id4 === L3[2].id, `${tag} лента: ↓ три раза — три строки`, `верх ${id4}, ждали ${L3[2].id}`);
		await page.keyboard.press("ArrowUp");
		await rbSettle(page);
		const id5 = await topIdAfter();
		step(id5 === L3[1].id, `${tag} лента: ↑ — одна строка назад`, `верх ${id5}, ждали ${L3[1].id}`);
		step((await rbMetrics(page)).top?.word === (await dw(page)), `${tag} лента: после колеса место — верхнее слово`);
		await rbTap(page, "left"); // дальше сценарий идёт от экрана, а не от строки
		// свайп (только Chromium: CDP): влево — вперёд, вправо — назад
		if (BROWSER === "chromium") {
			const cdp = await ctx.newCDPSession(page);
			const swipe = async (x0, x1) => {
				const y = m0.y + m0.H / 2;
				await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
				for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 6, y }] });
				await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await rbSettle(page);
			};
			const s0 = await rbMetrics(page);
			await swipe(m0.x + m0.w * 0.8, m0.x + m0.w * 0.3);
			const s1 = await rbMetrics(page);
			// экран узнаём по строке, а не по scrollTop: кусок сверху может законно уйти из DOM и сдвинуть все координаты
			step(s1.topId !== undefined && s1.topId === s0.nextId && Math.abs(s1.topOff) <= 1.2, `${tag} лента: свайп влево — экран вперёд`, `верх ${s1.topId} (${s1.topOff?.toFixed(1)} px), ждали ${s0.nextId}`);
			await swipe(m0.x + m0.w * 0.3, m0.x + m0.w * 0.8);
			const s2 = await rbMetrics(page);
			step(s2.topId !== undefined && s2.topId === s0.topId && Math.abs(s2.topOff) <= 1.2, `${tag} лента: свайп вправо — прежний экран`, `верх ${s2.topId} (${s2.topOff?.toFixed(1)} px), ждали ${s0.topId}`);
		}

		// граница куска: до конца первого куска три экрана, дальше 15 касаний вперёд
		await page.evaluate(() => {
			const win = document.querySelector(".rb-window");
			const first = win.querySelector("section.rb-chunk");
			win.scrollTop = first.offsetTop + first.offsetHeight - 3 * win.clientHeight;
		});
		await rbSettle(page);
		// Chrome съедает первое касание, если оно пришло вскоре после синтетических касаний CDP и программной прокрутки (событие click не приходит): без паузы счёт 15 вперёд и 15 назад сбивается
		await page.waitForTimeout(1500);
		const chunk0 = (await rbMetrics(page)).top?.chunk;
		let nums = [await rbNum(page)];
		let maxSections = 0;
		let maxVisible = 0;
		const tooMany = [];
		const visibleSections = (p) => p.evaluate(() => { const w = document.querySelector(".rb-window").getBoundingClientRect(); return [...document.querySelectorAll(".rb-window section")].filter((s) => { const r = s.getBoundingClientRect(); return r.bottom > w.top && r.top < w.bottom; }).length; });
		const chunksSeen = new Set([chunk0]);
		for (let i = 0; i < 15; i++) {
			await rbTap(page, "right");
			const m = await rbMetrics(page);
			maxSections = Math.max(maxSections, m.sections);
			const vis = await visibleSections(page);
			maxVisible = Math.max(maxVisible, vis);
			if (m.sections > Math.max(3, vis)) tooMany.push(`${m.sections}/${vis}`);
			chunksSeen.add(m.top?.chunk);
			nums.push(await rbNum(page));
		}
		step(chunksSeen.size >= 2, `${tag} лента: 15 касаний вперёд прошли границу главы`, [...chunksSeen].join(","));
		step(nums.every((n, i) => i === 0 || n >= nums[i - 1]) && nums[nums.length - 1] > nums[0], `${tag} лента: номер страницы растёт`, nums.join(" "));
		step(tooMany.length === 0, `${tag} лента: в DOM не больше 3 кусков после паузы (больше — только если на экране больше)`, `макс ${maxSections}, на экране ${maxVisible}, нарушения ${tooMany.join(" ")}`);
		await page.waitForTimeout(300);
		step((await rbMetrics(page)).sections <= Math.max(3, await visibleSections(page)), `${tag} лента: после паузы 300 мс — не больше 3 кусков`);
		// назад через границу: тот же путь по экранам
		const back = [];
		for (let i = 0; i < 15; i++) {
			await rbTap(page, "left");
			back.push(Math.round((await rbMetrics(page)).st));
		}
		const end = await rbMetrics(page);
		step(end.top?.chunk === chunk0 && end.sections <= Math.max(3, await visibleSections(page)), `${tag} лента: 15 касаний назад вернули в тот же кусок`, `кусок ${end.top?.chunk} ждали ${chunk0}, секций ${end.sections}, верх ${back.join(" ")}`);

		// зажатый пробел: 40 нажатий подряд без ожидания; после остановки куски не копятся, место — верхнее слово
		const holdNum0 = await rbNum(page);
		const holdMax = [];
		for (let i = 0; i < 40; i++) {
			await page.keyboard.press("Space");
			if (i % 8 === 7) holdMax.push((await rbMetrics(page)).sections);
		}
		await rbSettle(page);
		const hm = await rbMetrics(page);
		const hv = await visibleSections(page);
		step(hm.sections <= Math.max(3, hv), `${tag} лента: зажатый пробел (40 нажатий) — после паузы не больше 3 кусков`, `секций ${hm.sections}, на экране ${hv}, по ходу ${holdMax.join(" ")}`);
		step(hm.top?.word === (await dw(page)) && (await rbWordOnTop(page, hm.top.word)) && (await rbNum(page)) > holdNum0, `${tag} лента: зажатый пробел — место верхнее слово, страница выросла`, `${holdNum0} -> ${await rbNum(page)}`);

		// поиск фразы на ~60% книги: слово совпадения — в верхней строке
		const pick = await pickPhrase(page, 0.6);
		if (!step(!!pick, `${tag} лента: фраза для поиска найдена`)) throw new Error("нет фразы");
		await page.keyboard.press("Control+f");
		await page.waitForSelector(".sheet-backdrop.open .search input", { timeout: 3000 });
		await page.waitForTimeout(300);
		await page.keyboard.type(pick.phrase.toUpperCase().replace(/Ё/g, "Е"), { delay: 5 });
		await page.waitForTimeout(600);
		const first = await page.$(".search-item");
		if (!step(!!first, `${tag} лента: поиск нашёл фразу`)) throw new Error("нет совпадений");
		const target = Number(await first.getAttribute("data-word"));
		await first.click();
		await page.waitForTimeout(700);
		step((await dw(page)) === target && (await rbWordOnTop(page, target)), `${tag} лента: поиск — слово совпадения в верхней строке`, `${await dw(page)} == ${target}`);
		step((await page.evaluate(() => !!document.querySelector(".rb-window span.here"))), `${tag} лента: слово совпадения подсвечено`);
		await shot("4-search");

		// «По слову» и обратно: то же слово наверху
		await toMode(page, "words", ".mode-words .word .p");
		const ww = await dw(page);
		await toMode(page, "pages", ".rb-window span[data-w]");
		await page.waitForTimeout(400);
		step((await dw(page)) === ww && (await rbWordOnTop(page, ww)), `${tag} лента: «По слову» и назад — то же слово наверху`, `${ww} -> ${await dw(page)}`);

		// размер шрифта: верхнее слово то же
		const openSettings = async () => {
			await page.click('[aria-label="Настройки"]');
			await page.waitForSelector('.sheet-backdrop input[aria-label="Размер текста"]');
		};
		const wf = await dw(page);
		await openSettings();
		const size = page.locator('.sheet-backdrop input[aria-label="Размер текста"]');
		const size0 = await size.inputValue();
		await size.fill("28");
		await page.waitForTimeout(800);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(600);
		step((await dw(page)) === wf && (await rbWordOnTop(page, wf)), `${tag} лента: размер текста 28 px, верхнее слово то же`, `${wf} -> ${await dw(page)}`);
		await openSettings();
		await page.locator('.sheet-backdrop input[aria-label="Размер текста"]').fill(size0);
		await page.waitForTimeout(800);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(600);
		step((await dw(page)) === wf && (await rbWordOnTop(page, wf)), `${tag} лента: размер текста вернули, верхнее слово то же`, `${wf} -> ${await dw(page)}`);

		// смена окна: верхнее слово то же
		const alt = W >= 800 ? [390, 844] : [W === 390 ? 1280 : 1100, 700];
		await page.setViewportSize({ width: alt[0], height: alt[1] });
		await page.waitForTimeout(1000);
		step((await dw(page)) === wf && (await rbWordOnTop(page, wf)) && !(await hscroll(page)), `${tag} лента: окно ${alt[0]}x${alt[1]}, верхнее слово то же`, `${wf} -> ${await dw(page)}`);
		await page.setViewportSize({ width: W, height: H });
		await page.waitForTimeout(1000);
		step((await dw(page)) === wf && (await rbWordOnTop(page, wf)), `${tag} лента: окно вернули, верхнее слово то же`);

		// закладка из выделенного: шесть слов
		const mt = await rbMetrics(page);
		const q0 = mt.top.word;
		const quote = await page.evaluate((a) => {
			const r = document.createRange();
			r.setStartBefore(document.querySelector(`.rb-window span[data-w="${a}"]`));
			r.setEndAfter(document.querySelector(`.rb-window span[data-w="${a + 5}"]`));
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
			return r.toString().replace(/\s+/g, " ").trim();
		}, q0);
		await page.waitForTimeout(150);
		await page.click('[aria-label="Закладка здесь"]');
		await page.waitForTimeout(400);
		const marked = await page.evaluate(() => [...document.querySelectorAll(".rb-window span.pg-mark")].map((e) => Number(e.dataset.w)));
		step(marked.length === 6 && marked[0] === q0 && marked[5] === q0 + 5, `${tag} лента: закладка-цитата — подсвечены 6 слов`, marked.join(","));
		step((await page.textContent("#toast")) === "Цитата в закладках", `${tag} лента: тост «Цитата в закладках»`);
		await page.click('[aria-label="Оглавление и закладки"]');
		await page.waitForSelector(".sheet-backdrop");
		await page.click('.sheet-backdrop [role="tab"]:nth-of-type(2)');
		const list = await page.evaluate(() => [...document.querySelectorAll(".sheet-backdrop .mark-go > span")].map((e) => ({ t: e.textContent, quote: e.classList.contains("mark-quote") })));
		step(list.length === 1 && list[0].quote && list[0].t === `«${quote}»`, `${tag} лента: в списке закладок цитата`, JSON.stringify(list));
		await page.click('.sheet-backdrop [aria-label="Удалить закладку"]');
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);
		step((await page.evaluate(() => document.querySelectorAll(".rb-window span.pg-mark").length)) === 0, `${tag} лента: удалили закладку — подсветка пропала`);

		step(!(await hscroll(page)), `${tag} лента: нет горизонтальной прокрутки в конце`);
	} catch (e) {
		step(false, `${tag} лента: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-ribbon-ERROR.png` }).catch(() => {});
	}
	await ctx.close();

	// без настроек на телефоне (грубый указатель) — лента; в WebKit isMobile нет
	if (BROWSER === "chromium") {
		const mctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });
		const mp = await mctx.newPage();
		try {
			await mp.goto(base);
			await mp.waitForSelector(".library .actions");
			await mp.setInputFiles('input[type="file"]', BOOK);
			await mp.waitForSelector("div.book[data-mode]", { timeout: 90000 });
			await toMode(mp, "pages", ".pg-content span[data-w]");
			step(!!(await mp.$(".mode-ribbon .rb-window")) && !(await mp.$(".pg-viewport")), `${tag} лента: isMobile — лента`);
			await mp.screenshot({ path: `${OUT}/${tag}-ribbon-mobile.png` });
		} catch (e) {
			step(false, `${tag} лента: isMobile — сценарий оборвался`, String(e.message).split("\n")[0]);
		}
		await mctx.close();
	}
	// мышь, да ещё и старая настройка «Листание: страницами» в хранилище: читается без ошибок, ничего не меняет, лента та же
	// имя убранной настройки «Листание» собрано из частей: в исходниках его больше нет
	const dctx = await newCtx({ viewport: { width: W, height: H } });
	await dctx.addInitScript(() => {
		try {
			if (!localStorage.getItem("polka:settings")) localStorage.setItem("polka:settings", JSON.stringify({ ["page" + "Flow"]: "pages" }));
		} catch {}
	});
	const dp = await dctx.newPage();
	const dErrors = [];
	dp.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && dErrors.push(e.message));
	dp.on("console", (m) => m.type() === "error" && dErrors.push(m.text()));
	try {
		await dp.goto(base);
		await dp.waitForSelector(".library .actions");
		await dp.setInputFiles('input[type="file"]', BOOK);
		await dp.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await toMode(dp, "pages", ".pg-content span[data-w]");
		step(!!(await dp.$(".mode-ribbon .rb-window")) && !(await dp.$(".pg-viewport")), `${tag} лента: мышь и старая настройка «страницами» в хранилище — лента`);
		await dp.click('[aria-label="Настройки"]');
		await dp.waitForSelector(".sheet-backdrop input[aria-label=\"Размер текста\"]");
		step((await dp.$$(".sheet-backdrop [aria-label=\"Листание\"]")).length === 0, `${tag} лента: в настройках нет строки «Листание»`);
		step(dErrors.length === 0, `${tag} лента: старая настройка прочитана без ошибок`, dErrors.join(" | "));
	} catch (e) {
		step(false, `${tag} лента: мышь — сценарий оборвался`, String(e.message).split("\n")[0]);
	}
	await dctx.close();
}

async function ribbonImgFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	const shot = (n) => page.screenshot({ path: `${OUT}/${tag}-ribbon-${n}.png` });
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} лента: ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} лента: ошибка в консоли`, m.text()));
	const figs = () =>
		page.evaluate(() => {
			const win = document.querySelector(".rb-window");
			const wr = win.getBoundingClientRect();
			return [...win.querySelectorAll("figure.pg-fig")].map((f) => {
				const r = f.getBoundingClientRect();
				const im = f.querySelector("img");
				return { i: im.dataset.i, top: r.top - wr.top, bottom: r.bottom - wr.top, h: r.height, ok: im.complete && im.naturalWidth > 0 };
			});
		});
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await openRibbon(page);
		let tallest = 0;
		let seen = new Set();
		let cut = null;
		let shownFig = false;
		for (let n = 0; n < 260; n++) {
			const m = await rbMetrics(page);
			const fs = await figs();
			for (const f of fs) {
				seen.add(f.i);
				tallest = Math.max(tallest, f.h);
			}
			const vis = fs.find((f) => f.top >= 0 && f.bottom <= m.H);
			if (vis && !shownFig) {
				shownFig = true;
				await shot("5-figure");
			}
			// рисунок виден, но обрезан внизу
			const c = cut ? null : fs.find((f) => f.top > 1 && f.top < m.H - 1 && f.bottom > m.H + 1);
			if (c) {
				cut = { id: c.i, before: m };
				await shot("6-figure-cut");
				await rbTap(page, "right");
				const after = (await figs()).find((f) => f.i === c.i);
				step(!!after && Math.abs(after.top) <= 1.5, `${tag} лента: рисунок ${c.i} обрезан внизу — следующий экран начинается с него`, after ? `верх рисунка ${after.top.toFixed(1)}` : "нет рисунка");
				await shot("7-figure-top");
				// нажатие на рисунок открывает просмотр, нажатие в любом месте закрывает
				await page.click(`.rb-window img.pg-img[data-i="${c.i}"]`);
				await page.waitForSelector(".pg-viewer", { timeout: 5000 });
				step(true, `${tag} лента: нажатие на рисунок открывает просмотр`);
				await page.mouse.click(W / 2, H / 2);
				await page.waitForTimeout(300);
				step(!(await page.$(".pg-viewer")), `${tag} лента: просмотр закрылся`);
				continue;
			}
			const st0 = m.st;
			await rbTap(page, "right");
			if ((await rbScroll(page)) === st0) break;
		}
		step(seen.size > 0 && tallest <= H, `${tag} лента: рисунки (${seen.size}) не выше экрана`, `самый высокий ${Math.round(tallest)} при окне ${H}`);
		step(!!cut, `${tag} лента: нашёлся рисунок, обрезанный внизу`);
		step(!(await hscroll(page)), `${tag} лента: нет горизонтальной прокрутки`);
	} catch (e) {
		step(false, `${tag} лента: рисунки — сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-ribbon-img-ERROR.png` }).catch(() => {});
	}
	await ctx.close();
}

// ---- Съезд экрана вбок: копия уходящего экрана («призрак») и окно, что въезжает; ведение пальцем
const slideInfo = (p) =>
	p.evaluate(() => {
		const g = document.querySelector(".rb-ghost");
		const c = document.querySelector(".rb-content");
		const tx = (el) => {
			if (!el) return null;
			const t = getComputedStyle(el).transform;
			return t === "none" ? 0 : new DOMMatrix(t).m41;
		};
		return {
			ghost: !!g,
			ghosts: document.querySelectorAll(".rb-ghost").length,
			gx: tx(g),
			cx: tx(c),
			ghostWords: g ? g.querySelectorAll("span[data-w]").length : 0,
			settled: document.querySelector(".rb-window").dataset.settled,
		};
	});
// Слов с одним номером на странице больше одного (ищет и в призраке)
const dupWords = (p) =>
	p.evaluate(() => {
		const seen = new Set();
		let d = 0;
		for (const s of document.querySelectorAll("span[data-w]")) {
			if (seen.has(s.dataset.w)) d++;
			seen.add(s.dataset.w);
		}
		return d;
	});

// Точка касания справа или слева вне рисунка
async function tapPoint(p, side) {
	const m = await rbMetrics(p);
	const x = m.x + m.w * (side === "right" ? 0.8 : 0.15);
	const y = await p.evaluate(
		([x, y0, h]) => {
			for (const k of [0.5, 0.15, 0.85, 0.3, 0.7, 0.05, 0.95]) {
				const el = document.elementFromPoint(x, y0 + h * k);
				if (el && !el.closest("img.pg-img")) return y0 + h * k;
			}
			return y0 + h / 2;
		},
		[x, m.y, m.H],
	);
	return [x, y];
}

// Касание без ожидания конца съезда
async function slideTap(p, side) {
	const [x, y] = await tapPoint(p, side);
	await p.touchscreen.tap(x, y);
}

async function slideFlow(W, H, tag) {
	const ctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true });
	const page = await ctx.newPage();
	page.on("pageerror", (e) => !/ResizeObserver loop/.test(e.message) && step(false, `${tag} съезд: ошибка страницы`, e.message));
	page.on("console", (m) => m.type() === "error" && step(false, `${tag} съезд: ошибка в консоли`, m.text()));
	try {
		await page.goto(base);
		await page.waitForSelector(".library .actions");
		await page.setInputFiles('input[type="file"]', BOOK);
		await page.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await openRibbon(page);
		const m0 = await rbMetrics(page);
		const cw = await page.evaluate(() => document.querySelector(".rb-window").clientWidth);
		const tapAt = (side) => slideTap(page, side);
		// у начала книги (окно только открыто): листания нет, у пальца сопротивление втрое
		const wStart = await dw(page);
		await tapAt("left");
		await page.waitForTimeout(90);
		step(!(await slideInfo(page)).ghost && (await rbScroll(page)) === 0, `${tag} съезд: касание слева в начале книги — копии нет, место прежнее`, JSON.stringify(await slideInfo(page)));
		await rbSettle(page);
		if (BROWSER === "chromium") {
			const cdp = await ctx.newCDPSession(page);
			const y0 = Math.round(m0.y + m0.H / 2);
			const x0 = Math.round(m0.x + m0.w / 2);
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
			for (let i = 1; i <= 4; i++) {
				await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + i * 17, y: y0 }] });
				await page.waitForTimeout(20);
			}
			await page.waitForTimeout(60);
			const ed = await slideInfo(page);
			// палец ушёл на 68, сдвиг (68 - 8) / 3 = 20
			step(!ed.ghost && Math.abs(ed.cx - 20) <= 1.5, `${tag} ведение: у начала книги экран идёт втрое медленнее пальца и копии нет`, JSON.stringify(ed));
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await rbSettle(page);
			const ed2 = await slideInfo(page);
			step(ed2.cx === 0 && (await rbScroll(page)) === 0 && (await dw(page)) === wStart, `${tag} ведение: у начала книги отпустил — на месте, листания нет`, JSON.stringify(ed2));
		}
		// старт с узла сетки экранов: два листания клавишей от открытия книги (после прокрутки по строкам номер у рисунков может шагнуть на 2)
		await page.waitForTimeout(1500); // первое касание после синтетических касаний CDP Chrome съедает
		for (let i = 0; i < 2; i++) await nextScreen(page);

		// касание справа: через ~90 мс копия уезжает влево, через 400 мс её нет, верх — ожидаемый экран
		const a = await rbMetrics(page);
		const na = await rbNum(page);
		const wa = await dw(page);
		await tapAt("right");
		await page.waitForTimeout(90);
		const mid = await slideInfo(page);
		await page.screenshot({ path: `${OUT}/${tag}-slide-mid.png` });
		step(mid.ghost && mid.gx < -2 && mid.gx > -cw && mid.cx > 0 && mid.settled === "0", `${tag} съезд: через 90 мс копия уезжает влево, окно въезжает справа`, JSON.stringify(mid));
		step(mid.ghostWords === 0 && (await dupWords(page)) === 0, `${tag} съезд: в копии нет span[data-w], слов с одним номером нет`, `в копии ${mid.ghostWords}, повторов ${await dupWords(page)}`);
		const nMid = await rbNum(page);
		step((await dw(page)) > wa && nMid === na + 1, `${tag} съезд: место и номер страницы по новому экрану сразу`, `слово ${wa} -> ${await dw(page)}, номер ${na} -> ${nMid}`);
		await page.waitForTimeout(310);
		const after = await slideInfo(page);
		const b = await rbMetrics(page);
		step(!after.ghost && after.cx === 0 && after.settled === "1" && (await rbNum(page)) === nMid, `${tag} съезд: через 400 мс копии нет, окно на месте, номер не менялся`, JSON.stringify(after));
		// экран узнаём по строке, а не по scrollTop: кусок сверху может законно уйти из DOM и сдвинуть координаты
		step(b.topId !== undefined && b.topId === a.nextId && Math.abs(b.topOff) <= 1.2 && (await onOpenPage(page)), `${tag} съезд: верх — ожидаемый экран, верхняя строка вровень с краем`, `${a.topId} -> ${b.topId}, ждали ${a.nextId}, отступ ${b.topOff}`);
		step((await dupWords(page)) === 0, `${tag} съезд: после съезда span[data-w] не дублируются`);

		// три касания по 50 мс — ровно три экрана (те же, что при трёх касаниях с ожиданием); три обратно — исходный
		const n1 = await rbNum(page);
		const t1 = (await rbMetrics(page)).topId;
		for (let i = 0; i < 3; i++) {
			await tapAt("right");
			await rbSettle(page);
		}
		const tSlow = (await rbMetrics(page)).topId;
		const nSlow = await rbNum(page);
		for (let i = 0; i < 3; i++) {
			await tapAt("left");
			await rbSettle(page);
		}
		step((await rbMetrics(page)).topId === t1 && (await rbNum(page)) === n1, `${tag} съезд: три касания по одному вперёд и назад — на исходный экран`, `${t1} -> ${tSlow} -> ${(await rbMetrics(page)).topId}`);
		for (let i = 0; i < 3; i++) {
			await tapAt("right");
			await page.waitForTimeout(50);
		}
		await rbSettle(page);
		step(tSlow !== t1 && nSlow === n1 + 3 && (await rbMetrics(page)).topId === tSlow && (await rbNum(page)) === n1 + 3 && (await onOpenPage(page)) && Math.abs((await rbMetrics(page)).topOff) <= 1.2, `${tag} съезд: три касания по 50 мс — ровно три экрана`, `верх ${(await rbMetrics(page)).topId}, ждали ${tSlow}, номер ${n1} -> ${await rbNum(page)}, ждали ${nSlow}`);
		for (let i = 0; i < 3; i++) {
			await tapAt("left");
			await page.waitForTimeout(50);
		}
		await rbSettle(page);
		step((await rbMetrics(page)).topId === t1 && (await rbNum(page)) === n1, `${tag} съезд: три касания слева по 50 мс — на исходный экран`, `${t1} ждали, ${(await rbMetrics(page)).topId}`);

		// клавиша: тот же съезд (вправо — копия влево; назад — копия вправо)
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(90);
		const k1 = await slideInfo(page);
		await page.waitForTimeout(310);
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(90);
		const k2 = await slideInfo(page);
		await rbSettle(page);
		step(k1.ghost && k1.gx < -2 && k2.ghost && k2.gx > 2 && (await rbMetrics(page)).topId === t1, `${tag} съезд: → копия влево, ← копия вправо, назад на исходный экран`, `${k1.gx?.toFixed(0)} / ${k2.gx?.toFixed(0)}`);

		// по строке — без съезда
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(60);
		step(!(await slideInfo(page)).ghost, `${tag} съезд: стрелка вниз на строку — копии нет`);
		await rbSettle(page);
		await page.keyboard.press("ArrowUp");
		await rbSettle(page);

		if (BROWSER === "chromium") {
			const cdp = await ctx.newCDPSession(page);
			const down = async (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			const move = async (x, y) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
			const up = async () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			const y0 = Math.round(m0.y + m0.H / 2);
			const x0 = Math.round(m0.x + m0.w / 2);
			const s0 = await rbMetrics(page);
			const ns = await rbNum(page);
			const ws = await dw(page);

			// ведение 30 px: экран идёт за пальцем (сдвиг за вычетом порога 8), справа уже виден следующий, отпустил — вернулся, место прежнее
			await down(x0, y0);
			for (let i = 1; i <= 4; i++) {
				await move(x0 - Math.round((38 * i) / 4), y0);
				await page.waitForTimeout(20);
			}
			await page.waitForTimeout(80);
			const d1 = await slideInfo(page);
			step(d1.ghost && Math.abs(d1.gx + 30) <= 1.5 && Math.abs(d1.cx - (cw - 30)) <= 1.5 && (await dw(page)) === ws && (await rbNum(page)) === ns, `${tag} ведение: 30 px — копия на -30, окно на ширину правее, место и номер прежние`, JSON.stringify(d1));
			await up();
			await rbSettle(page);
			const d2 = await slideInfo(page);
			const e1 = await rbMetrics(page);
			step(!d2.ghost && d2.cx === 0 && e1.topId === s0.topId && Math.abs(e1.st - s0.st) <= 1.2 && (await dw(page)) === ws && (await rbNum(page)) === ns, `${tag} ведение: 30 px — вернулся, прокрутка, место и номер прежние`, `${s0.st} -> ${e1.st}, слово ${ws} -> ${await dw(page)}`);

			// 120 px: экран вперёд; назад 120 — на прежний
			await down(x0, y0);
			for (let i = 1; i <= 6; i++) {
				await move(x0 - Math.round((128 * i) / 6), y0);
				await page.waitForTimeout(20);
			}
			await page.waitForTimeout(60);
			const d3 = await slideInfo(page);
			await up();
			await rbSettle(page);
			const e2 = await rbMetrics(page);
			step(d3.ghost && Math.abs(d3.gx + 120) <= 1.5 && e2.topId === s0.nextId && Math.abs(e2.topOff) <= 1.2 && (await rbNum(page)) === ns + 1 && (await onOpenPage(page)), `${tag} ведение: 120 px — копия на -120, после отпускания экран вперёд, номер +1`, `gx ${d3.gx?.toFixed(1)}, верх ${e2.topId} ждали ${s0.nextId}, номер ${await rbNum(page)}`);
			await down(x0, y0);
			for (let i = 1; i <= 6; i++) {
				await move(x0 + Math.round((128 * i) / 6), y0);
				await page.waitForTimeout(20);
			}
			await up();
			await rbSettle(page);
			const e3 = await rbMetrics(page);
			step(e3.topId === s0.topId && Math.abs(e3.st - s0.st) <= 1.2 && (await rbNum(page)) === ns && (await dw(page)) === ws, `${tag} ведение: вправо 120 px — назад на прежний экран точно`, `${s0.st} -> ${e3.st}`);

			// смена направления посреди жеста: сначала влево, потом вправо за точку касания — цель назад
			await down(x0, y0);
			for (let i = 1; i <= 3; i++) {
				await move(x0 - i * 20, y0);
				await page.waitForTimeout(20);
			}
			for (let i = 1; i <= 6; i++) {
				await move(x0 - 60 + i * 22, y0);
				await page.waitForTimeout(20);
			}
			await page.waitForTimeout(60);
			const d4 = await slideInfo(page);
			// палец ушёл на +72: сдвиг 72 - 8 = 64, прежний экран виден слева
			step(d4.ghost && Math.abs(d4.gx - 64) <= 1.5 && Math.abs(d4.cx - (64 - cw)) <= 1.5, `${tag} ведение: смена направления — теперь виден прежний экран слева`, JSON.stringify(d4));
			await up();
			await rbSettle(page);
			step((await rbNum(page)) === ns - 1 && (await onOpenPage(page)) && !(await slideInfo(page)).ghost, `${tag} ведение: смена направления, отпустил — экран назад`, `номер ${ns} -> ${await rbNum(page)}`);
			await page.keyboard.press("ArrowRight");
			await rbSettle(page);

			// вертикальный жест — обычная прокрутка, съезда нет
			const sv = await rbScroll(page);
			await down(x0, y0);
			let ghostSeen = false;
			for (let i = 1; i <= 6; i++) {
				await move(x0, y0 - i * 15);
				await page.waitForTimeout(20);
				ghostSeen = ghostSeen || (await slideInfo(page)).ghost;
			}
			await up();
			await page.waitForTimeout(300);
			step(!ghostSeen && (await rbScroll(page)) - sv > 30, `${tag} ведение: вертикальный жест — прокрутка, копии нет`, `${sv} -> ${await rbScroll(page)}`);
			await rbSettle(page);
			await page.keyboard.press("ArrowRight");
			await rbSettle(page);

			// выделение в тексте: свайп не листает и не двигает экран
			const q = (await rbMetrics(page)).top?.word;
			if (q !== undefined) {
				await page.evaluate((a) => {
					const r = document.createRange();
					r.setStartBefore(document.querySelector(`.rb-window span[data-w="${a}"]`));
					r.setEndAfter(document.querySelector(`.rb-window span[data-w="${a + 3}"]`));
					const sel = getSelection();
					sel.removeAllRanges();
					sel.addRange(r);
				}, q);
				await page.waitForTimeout(200);
				const nSel = await rbNum(page);
				await down(x0, y0);
				let g2 = false;
				for (let i = 1; i <= 6; i++) {
					await move(x0 - i * 22, y0);
					await page.waitForTimeout(20);
					g2 = g2 || (await slideInfo(page)).ghost;
				}
				await up();
				await rbSettle(page);
				step(!g2 && (await rbNum(page)) === nSel, `${tag} ведение: при выделении в тексте свайп не листает`, `номер ${nSel} -> ${await rbNum(page)}`);
				await page.evaluate(() => getSelection().removeAllRanges());
				await page.waitForTimeout(200);
			}

			// касание с дрожью пальца: 10 px вбок — всё равно касание, ровно один экран вперёд
			// Chromium не доносит до страницы сдвиги в пределах своего порога касания, а Safari доносит: события собираем сами (touchstart, touchmove, touchend, затем click, как шлёт Safari)
			const jit = async (side, dx, dy) => {
				const [x, y] = await tapPoint(page, side);
				await page.evaluate(
					async ([x, y, dx, dy]) => {
						const win = document.querySelector(".rb-window");
						const el = document.elementFromPoint(x, y) ?? win;
						const tch = (px, py) => new Touch({ identifier: 7, target: el, clientX: px, clientY: py });
						const fire = (type, list, ch) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: ch }));
						const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
						el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerType: "touch" }));
						fire("touchstart", [tch(x, y)], [tch(x, y)]);
						await sleep(40);
						fire("touchmove", [tch(x + dx, y + dy)], [tch(x + dx, y + dy)]);
						await sleep(120);
						fire("touchend", [], [tch(x + dx, y + dy)]);
						el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
					},
					[x, y, dx, dy],
				);
				await page.waitForTimeout(700);
				await rbSettle(page);
			};
			const j0 = await rbMetrics(page);
			const nj = await rbNum(page);
			await jit("right", -10, 0);
			const j1 = await rbMetrics(page);
			step(j1.topId !== undefined && j1.topId === j0.nextId && Math.abs(j1.topOff) <= 1.2 && (await rbNum(page)) === nj + 1, `${tag} ведение: касание с дрожью пальца на 10 px вбок — один экран вперёд`, `верх ${j1.topId}, ждали ${j0.nextId}, номер ${nj} -> ${await rbNum(page)}`);
			// дрожь вниз на 7 px: касание листает вперёд и не стирает «назад — ровно прежний экран»
			await page.keyboard.press("ArrowRight");
			await rbSettle(page);
			const j2 = await rbMetrics(page);
			await jit("right", 0, 7);
			const j3 = await rbMetrics(page);
			await jit("left", 0, 0);
			const j4 = await rbMetrics(page);
			await jit("left", 0, 0);
			const j5 = await rbMetrics(page);
			step(j3.topId === j2.nextId && j4.topId === j2.topId && j5.topId === j1.topId && Math.abs(j5.topOff) <= 1.2, `${tag} ведение: дрожь вниз на 7 px листает, затем два назад — ровно прежние экраны`, `верх ${j2.topId} -> ${j3.topId} (ждали ${j2.nextId}) -> ${j4.topId} -> ${j5.topId} (ждали ${j1.topId})`);

			// рывок: 38 px одним движением листает
			const nf = await rbNum(page);
			await down(x0, y0);
			await move(x0 - 38, y0);
			await up();
			await rbSettle(page);
			step((await rbNum(page)) === nf + 1 && (await onOpenPage(page)), `${tag} ведение: быстрый рывок на 38 px — экран вперёд`, `${nf} -> ${await rbNum(page)}`);
		}

		step(!(await hscroll(page)), `${tag} съезд: нет горизонтальной прокрутки`);
	} catch (e) {
		step(false, `${tag} съезд: сценарий оборвался`, String(e.message).split("\n")[0]);
		await page.screenshot({ path: `${OUT}/${tag}-slide-ERROR.png` }).catch(() => {});
	}
	await ctx.close();

	// «уменьшить движение»: ни съезда, ни ведения
	const rctx = await newCtx({ viewport: { width: W, height: H }, hasTouch: true, reducedMotion: "reduce" });
	const rp = await rctx.newPage();
	try {
		await rp.goto(base);
		await rp.waitForSelector(".library .actions");
		await rp.setInputFiles('input[type="file"]', BOOK);
		await rp.waitForSelector("div.book[data-mode]", { timeout: 90000 });
		await openRibbon(rp);
		await rp.evaluate((h) => document.querySelector(".rb-window").scrollBy(0, h * 1.5), (await rbMetrics(rp)).H);
		await rbSettle(rp);
		const r0 = await rbMetrics(rp);
		await slideTap(rp, "right");
		await rp.waitForTimeout(40);
		const ri = await slideInfo(rp);
		step(!ri.ghost && ri.cx === 0 && Math.abs((await rbScroll(rp)) - r0.nextTop) <= 1.2, `${tag} съезд: «уменьшить движение» — касание сразу, без копии`, JSON.stringify(ri));
		if (BROWSER === "chromium") {
			const c = await rctx.newCDPSession(rp);
			const y = Math.round(H / 2);
			const x = Math.round(W / 2);
			await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 60, y }] });
			await rp.waitForTimeout(60);
			const mid2 = await slideInfo(rp);
			await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			step(!mid2.ghost && mid2.cx === 0, `${tag} съезд: «уменьшить движение» — экран не идёт за пальцем`, JSON.stringify(mid2));
		}
	} catch (e) {
		step(false, `${tag} съезд reduced: сценарий оборвался`, String(e.message).split("\n")[0]);
	}
	await rctx.close();
}

console.log(`# ${BROWSER}, книга ${basename(BOOK)}, ${base}, снимки в ${OUT}`);
for (const [W, H] of SIZES) {
	const tag = `${BROWSER}-${bookName}-${W}x${H}`;
	console.log(`## ${W}x${H}`);
	if (process.env.ONLY === "ribbon") {
		await pageNumberFlow(W, H, tag);
		await markFlow(W, H, tag);
		await (IMG ? ribbonImgFlow : ribbonFlow)(W, H, tag);
		await slideFlow(W, H, tag);
		continue;
	}
	await (IMG ? imgFlow : browserFlow)(W, H, tag);
	if (!IMG) await searchFlow(W, H, tag);
	await pageNumberFlow(W, H, tag);
	await ticksFlow(W, H, tag);
	if (!IMG) await screenFlow(W, H, tag);
	await markFlow(W, H, tag);
	await (IMG ? ribbonImgFlow : ribbonFlow)(W, H, tag);
	await slideFlow(W, H, tag);
	if (BROWSER === "chromium") await folderFlow(W, H, tag);
	else console.log("SKIP режим папки: в WebKit нет showDirectoryPicker, запись в OPFS в Safari только из воркера");
}
await browser.close();
stopServer();
console.log(failed ? `ИТОГ: провалов ${failed}` : "ИТОГ: всё прошло");
process.exit(failed ? 1 : 0);
