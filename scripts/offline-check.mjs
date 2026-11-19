// Офлайн: открыть приложение с сетью, добавить книгу, выключить сеть, перезагрузить,
// открыть книгу и почитать во всех трёх режимах; по желанию загрузить без сети EPUB и PDF.
// Сначала `npm run build`: без BASE скрипт сам поднимает `vite preview` на dist/.
// Запуск: FB2=книга.fb2 [EPUB=...] [PDF=...] [BASE=http://...] node scripts/offline-check.mjs
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

if (!process.env.FB2) {
	console.error("Нужен FB2=путь/к/книге.fb2");
	process.exit(2);
}
let failed = 0;
const check = (ok, text) => {
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} ${text}`);
};

let server = null;
let base = process.env.BASE;
if (!base) {
	const port = await new Promise((res) => {
		const s = createServer();
		s.listen(0, () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
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

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const mode = (m, ready) => page.click(`[data-m="${m}"]`).then(() => page.waitForSelector(ready));

await page.goto(base);
await page.waitForSelector(".library .actions");
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload(); // страница под управлением service worker
await page.waitForSelector(".library .actions");
check(await page.evaluate(() => !!navigator.serviceWorker.controller), "страница под управлением service worker");
console.log("    постоянное хранилище:", await page.evaluate(() => navigator.storage?.persisted?.()));

await page.setInputFiles('input[type="file"]', process.env.FB2);
await page.waitForSelector("div.book[data-mode]", { timeout: 60000 });
await page.evaluate(() => (location.hash = "#/"));
await page.waitForSelector("article.book");

await ctx.setOffline(true);
await page.reload();
await page.waitForSelector("article.book", { timeout: 15000 });
check((await page.locator("article.book").count()) > 0, `без сети библиотека открылась, книг: ${await page.locator("article.book").count()}`);

await page.click(".book-open");
await page.waitForSelector("div.book[data-mode]");
if ((await page.evaluate(() => document.querySelector("div.book").dataset.mode)) !== "pages") await mode("pages", ".pg-content span[data-w]");
await page.waitForSelector(".pg-content span[data-w]");
const w0 = await page.evaluate(() => Number(document.querySelector("div.book").dataset.word));
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(300);
check((await page.evaluate(() => Number(document.querySelector("div.book").dataset.word))) > w0, "без сети страницы листаются");

await mode("words", ".mode-words .word .p");
await page.click(".play");
const words = new Set();
for (let i = 0; i < 12; i++) {
	await page.waitForTimeout(150);
	words.add(await page.locator(".mode-words .word").textContent());
}
await page.click(".play");
check(words.size > 1, `без сети «По слову» читает, слов сменилось: ${words.size}`);

await mode("typing", ".mode-typing .tape span.cur");
check(true, "без сети открылась «Печать»");

for (const [kind, file] of [["EPUB", process.env.EPUB], ["PDF", process.env.PDF]]) {
	if (!file) {
		console.log(`    ${kind}: файл не задан, пропуск`);
		continue;
	}
	await page.evaluate(() => (location.hash = "#/"));
	await page.waitForSelector(".library .actions");
	await page.setInputFiles('input[type="file"]', file);
	try {
		await page.waitForSelector("div.book[data-mode]", { timeout: 120000 });
		check(true, `без сети ${kind} загрузился и открылся`);
	} catch {
		const t = await page.locator("#toast").textContent().catch(() => "");
		check(false, `без сети ${kind} НЕ открылся: ${t}`);
	}
}
await browser.close();
stopServer();
console.log(failed ? `ИТОГ: провалов ${failed}` : "ИТОГ: всё прошло");
process.exit(failed ? 1 : 0);
