// Режим «Страницы», раскладка лентой: текст одной колонкой в обычном окне прокрутки.
// Палец двигает строки плавно, касание сбоку, клавиши и свайп листают на экран. Место — первое слово верхней строки, видимой целиком.
// В DOM лежат не больше трёх кусков подряд: нужный дописывается рядом, дальний убирается, когда прокрутка стоит.
import "./pages.css";
import { buildChunks, chunkOfWord, type Chunk } from "../../core/chunks";
import { PageNumbers } from "../../core/pagecount";
import { nextLineTop, nextScreenTop, prevLineTop, prevScreenTop } from "../../core/ribbon";
import type { FontKind, Settings } from "../../settings";
import { h } from "../dom";
import { FONT_OPTIONS, range, segmented, toggle } from "../settings-sheet";
import {
	createPagesContent,
	createSelection,
	detectLang,
	estimateBookPages,
	flowRow,
	FONT_FAMILY,
	footText,
	HERE_MS,
	MAX_PAGE_W,
	pageMargin,
	paintMarks,
	reducedMotion,
	type Fig,
	type FigGeometry,
} from "./pages-content";
import { createFigureViewer } from "./pages-viewer";
import type { ModeHost, ModeView } from "./types";

const SWIPE_PX = 40;
/** Дельта колеса в пикселях, с которой это засечка мыши, а не тачпад. */
const WHEEL_NOTCH_PX = 40;
/** Пауза в колесе, после которой накопленное тачпадом сбрасывается, мс. */
const WHEEL_PAUSE_MS = 200;
/** В DOM одновременно не больше стольких кусков. */
const MAX_CHUNKS = 3;
/** Запас текста по обе стороны экрана, в экранах: меньше — дописывается соседний кусок. */
const MARGIN_SCREENS = 1.5;
/** Прокрутка стоит столько — можно убрать дальний кусок, мс. */
const IDLE_MS = 150;
/** Касание в такое время после прокрутки считается остановкой прокрутки, а не листанием, мс. */
const SCROLLING_MS = 120;
/** Строка с верхом выше края окна не больше чем на это считается видимой целиком, px. */
const TOP_EPS = 1;

/** Строка текста или рисунок: верх и низ от верха куска и слово (у рисунка — первое слово после него). */
interface Line {
	top: number;
	bottom: number;
	word: number;
}

/** Кусок в DOM. top и height — в координатах содержимого, обновляются при пересчёте индекса. */
interface Loaded {
	i: number;
	section: HTMLElement;
	spans: HTMLElement[];
	figs: Fig[];
	lines: Line[];
	top: number;
	height: number;
}

/** Строки всех кусков в DOM подряд, в координатах содержимого. */
interface Flat {
	tops: number[];
	bottoms: number[];
	words: number[];
}

/** Первый индекс, где a[i] >= v. */
function lowerBound(a: number[], v: number): number {
	let lo = 0;
	let hi = a.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (a[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export async function ribbonMode(host: ModeHost, startWord: number): Promise<ModeView> {
	const s: Settings = host.settings;
	const { stream } = host;
	const total = stream.words.length;
	const tocParas = host.book.toc.map((t) => t.paragraph);
	const tocSet = new Set(tocParas);
	const chunks: Chunk[] = buildChunks(stream, host.book.paragraphs.length, tocParas);
	const lang = detectLang(host.book.paragraphs);
	const pc = createPagesContent({ host, chunks, tocSet, onRelayout: () => scheduleRelayout() });

	const content = h("div.rb-content", { lang });
	const win = h("div.rb-window", {}, content);
	const foot = h("footer.pg-foot");
	const view = h("div.mode-pages.mode-ribbon", {}, win, foot);

	let disposed = false;
	let hereTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let placeFrame = 0;
	let relayoutFrame = 0;
	// Размеры окна, для которых сделана раскладка; 0 — ещё не измерено
	let laidW = 0;
	let laidH = 0;
	/** Ширина текста, высота окна (экран), высота строки. */
	let colW = 0;
	let H = 0;
	let lineH = 0;
	let layoutSeq = 0;
	let highlightNext = true;
	/** Место в книге: первое слово верхней строки; меняется прокруткой, seek и входом. */
	let anchor = Math.max(0, Math.min(startWord, Math.max(0, total - 1)));
	/** scrollTop, при котором место было выставлено: движение меньше пикселя место не трогает. */
	let placeTop = 0;
	/** scrollTop, где прокрутка последний раз остановилась по нашей воле (скачок, листание, пауза). */
	let settledTop = 0;
	/** scrollTop, при котором куски последний раз дописывались: пока палец не ушёл дальше, поправка прокрутки от убранного куска не вызывает новых. */
	let fillTop = 0;
	/** Куда едет наша плавная прокрутка; null — своей прокрутки сейчас нет. */
	let progTarget: number | null = null;
	/** Верхи экранов, с которых листали вперёд: «назад» возвращает ровно на прежний экран. Пальцем и колесом сбрасывается. */
	let stack: number[] = [];
	let lastScrollAt = -1e9;
	let swipedAt = -1e9;

	let loaded: Loaded[] = [];
	let flat: Flat | null = null;
	let pageNums = new PageNumbers(chunks.map(() => 1));
	const viewer = createFigureViewer(pc.objectUrl);

	function word(): number {
		return anchor;
	}

	function geo(): FigGeometry {
		return { colW, colH: H, lineH };
	}

	/** Выставляет размеры под окно; false — окно ещё без размера. */
	function applyGeometry(): boolean {
		const w = win.clientWidth;
		const hh = win.clientHeight;
		if (w <= 0 || hh <= 0) return false;
		lineH = s.pageSize * s.lineHeight;
		const pageW = Math.min(w, MAX_PAGE_W);
		const m = pageMargin(pageW);
		view.style.setProperty("--pg-font", FONT_FAMILY[s.pageFont]);
		view.style.setProperty("--pg-size", `${s.pageSize}px`);
		// Подпись под рисунком — другого рода шрифт, чем основной текст
		view.style.setProperty("--pg-cap-font", s.pageFont === "serif" ? FONT_FAMILY.sans : FONT_FAMILY.serif);
		view.style.setProperty("--pg-cap-style", s.pageFont === "serif" ? "normal" : "italic");
		view.classList.toggle("justify", s.justify);
		colW = pageW - 2 * m;
		content.style.lineHeight = `${lineH}px`;
		content.style.width = `${colW}px`;
		H = hh;
		laidW = w;
		laidH = hh;
		return true;
	}

	// ---- куски в DOM и индекс строк

	/** Строки куска: у текста верх и низ — по центру первого слова строки, у рисунка — рамка figure. */
	function measureLines(l: Loaded): void {
		const c = chunks[l.i];
		const secTop = l.section.getBoundingClientRect().top;
		const lines: Line[] = [];
		for (const el of l.section.children) {
			if (el.tagName === "FIGURE") {
				const r = el.getBoundingClientRect();
				lines.push({ top: r.top - secTop, bottom: r.bottom - secTop, word: -1 });
				continue;
			}
			let lastTop = -1e9;
			for (const sp of el.children as HTMLCollectionOf<HTMLElement>) {
				const t = sp.offsetTop;
				if (t - lastTop < lineH * 0.5) continue; // та же строка
				lastTop = t;
				// слово с переносом по дефису лежит на двух строках: берём его первый кусок, а не рамку целиком
				const r = sp.getClientRects()[0] ?? sp.getBoundingClientRect();
				const mid = (r.top + r.bottom) / 2 - secTop;
				lines.push({ top: mid - lineH / 2, bottom: mid + lineH / 2, word: Number(sp.dataset.w) });
			}
		}
		// Рисунок стоит на месте слова, что идёт после него; в конце куска — первое слово следующего
		let next = c.toWord < total ? c.toWord : total - 1;
		for (let k = lines.length - 1; k >= 0; k--) {
			if (lines[k].word < 0) lines[k].word = next;
			else next = lines[k].word;
		}
		l.lines = lines;
	}

	/** Индекс строк всех кусков; пересчитывается после любых изменений DOM. */
	function index(): Flat {
		if (flat) return flat;
		const cTop = content.getBoundingClientRect().top;
		const tops: number[] = [];
		const bottoms: number[] = [];
		const words: number[] = [];
		for (const l of loaded) {
			const r = l.section.getBoundingClientRect();
			l.top = r.top - cTop;
			l.height = r.height;
			for (const ln of l.lines) {
				tops.push(l.top + ln.top);
				bottoms.push(l.top + ln.bottom);
				words.push(ln.word);
			}
		}
		flat = { tops, bottoms, words };
		return flat;
	}

	/** Сдвигает все запомненные положения: сверху добавили или убрали текст высотой delta. */
	function shiftCoords(delta: number): void {
		if (delta === 0) return;
		stack = stack.map((v) => v + delta);
		if (progTarget !== null) progTarget += delta;
		placeTop += delta;
		settledTop += delta;
		fillTop += delta;
	}

	function setScrollTop(v: number): void {
		win.scrollTop = Math.max(0, v);
	}

	/** Дописывает кусок i в конец или в начало; в начале прокрутка поправляется на высоту добавленного. Возвращает эту поправку. */
	function mount(i: number, at: "end" | "start"): number {
		const c = chunks[i];
		const ref = at === "start" ? loaded[0]?.section : undefined;
		const before = ref ? ref.getBoundingClientRect().top : 0;
		const section = h("section.pg-content.rb-chunk", { lang, "data-i": i });
		if (i === 0) section.classList.add("first");
		if (i === chunks.length - 1) section.classList.add("last");
		// кусок должен быть в документе до рендера: подписи рисунков меряются по высоте
		if (at === "end") content.append(section);
		else content.prepend(section);
		const r = pc.renderChunk(i, section, geo());
		paintMarks(section, r.spans, c.fromWord, c.toWord, host.bookmarks());
		const l: Loaded = { i, section, spans: r.spans, figs: r.figs, lines: [], top: 0, height: 0 };
		if (at === "end") loaded.push(l);
		else loaded.unshift(l);
		flat = null;
		measureLines(l);
		pageNums.setMeasured(i, Math.max(1, Math.ceil(section.getBoundingClientRect().height / H)));
		if (!ref) return 0;
		const delta = ref.getBoundingClientRect().top - before;
		if (delta !== 0) {
			setScrollTop(win.scrollTop + delta);
			shiftCoords(delta);
		}
		return delta;
	}

	/** Убирает крайний кусок; если убран верхний, прокрутка поправляется. */
	function unmount(at: "end" | "start"): void {
		const l = at === "start" ? loaded[0] : loaded[loaded.length - 1];
		if (!l) return;
		const ref = at === "start" ? loaded[1]?.section : undefined;
		const before = ref ? ref.getBoundingClientRect().top : 0;
		l.section.remove();
		if (at === "start") loaded.shift();
		else loaded.pop();
		flat = null;
		if (!ref) return;
		const delta = ref.getBoundingClientRect().top - before;
		if (delta !== 0) {
			setScrollTop(win.scrollTop + delta);
			shiftCoords(delta);
		}
	}

	function clearLoaded(): void {
		content.replaceChildren();
		loaded = [];
		flat = null;
	}

	/**
	 * Дописывает куски, чтобы вокруг экрана с верхом pos было не меньше полутора экранов текста.
	 * prepend=false — сверху не добавлять (идёт плавная прокрутка, поправка scrollTop её сорвала бы).
	 * Возвращает, на сколько сдвинулось содержимое из-за добавленного сверху: pos и верха экранов надо сдвинуть так же.
	 */
	function fill(pos: number, prepend = true): number {
		if (loaded.length === 0) return 0;
		const margin = MARGIN_SCREENS * H;
		let shifted = 0;
		while (loaded[loaded.length - 1].i < chunks.length - 1 && content.offsetHeight - (pos + H) < margin) mount(loaded[loaded.length - 1].i + 1, "end");
		while (prepend && loaded[0].i > 0 && pos < margin) {
			const d = mount(loaded[0].i - 1, "start");
			pos += d;
			shifted += d;
		}
		return shifted;
	}

	/** Убирает дальние куски, пока их больше трёх: тот конец, что дальше от середины экрана. Кусок, видимый на экране, не трогается. */
	function trim(): void {
		while (loaded.length > MAX_CHUNKS) {
			index();
			const st = win.scrollTop;
			const mid = st + H / 2;
			let k = loaded.findIndex((l) => mid < l.top + l.height);
			if (k < 0) k = loaded.length - 1;
			const visible = (l: Loaded) => l.top < st + H && l.top + l.height > st;
			const order: ("start" | "end")[] = k > loaded.length - 1 - k ? ["start", "end"] : ["end", "start"];
			const at = order.find((o) => !visible(o === "start" ? loaded[0] : loaded[loaded.length - 1]));
			if (!at) return;
			unmount(at);
		}
	}

	// ---- место, подвал

	/** Номер страницы: страниц в кусках до открытого плюс экраны от начала куска. */
	function updateFoot(): void {
		const ci = chunkOfWord(chunks, anchor);
		const l = loaded.find((x) => x.i === ci);
		let pg = 0;
		if (l) {
			index();
			const pages = Math.max(1, Math.ceil(l.height / H));
			pg = Math.min(pages - 1, Math.max(0, Math.floor((win.scrollTop - l.top) / H)));
		}
		foot.textContent = footText(pageNums.startOf(ci) + pg + 1, pageNums.total, anchor, total);
	}

	/** Место — первое слово верхней строки, видимой целиком; сообщается оболочке. */
	function updatePlace(): void {
		const st = win.scrollTop;
		if (Math.abs(st - placeTop) < 1) return;
		const ix = index();
		if (ix.tops.length === 0) return;
		const k = Math.min(lowerBound(ix.tops, st - TOP_EPS), ix.tops.length - 1);
		placeTop = st;
		anchor = ix.words[k];
		updateFoot();
		host.report(anchor);
	}

	function schedulePlace(): void {
		if (placeFrame) return;
		const run = () => {
			placeFrame = 0;
			if (disposed || loaded.length === 0) return;
			// дописываем, когда прокрутка ушла от прежнего места хотя бы на четверть экрана: у коротких глав иначе дописывание и уборка гоняли бы друг друга
			if (Math.abs(win.scrollTop - fillTop) >= H / 4) {
				fillTop = win.scrollTop;
				fill(win.scrollTop, progTarget === null);
			}
			updatePlace();
		};
		if (typeof requestAnimationFrame !== "function") return run();
		placeFrame = requestAnimationFrame(run);
	}

	function flashHere(w: number): void {
		content.querySelector("span.here")?.classList.remove("here");
		clearTimeout(hereTimer);
		const l = loaded.find((x) => w >= chunks[x.i].fromWord && w < chunks[x.i].toWord);
		const sp = l?.spans[w - chunks[l.i].fromWord];
		if (!sp) return;
		sp.classList.add("here");
		hereTimer = setTimeout(() => sp.classList.remove("here"), HERE_MS);
	}

	/** Открывает слово w: строка слова — верхняя. Куски вокруг дописываются. */
	function openAt(w: number, flash: boolean): void {
		if (chunks.length === 0) return;
		w = Math.max(0, Math.min(w, total - 1));
		const ci = chunkOfWord(chunks, w);
		if (!loaded.some((l) => l.i === ci)) {
			clearLoaded();
			for (const i of [ci - 1, ci, ci + 1]) if (i >= 0 && i < chunks.length) mount(i, "end");
		}
		const ix = index();
		const k = Math.max(0, lowerBound(ix.words, w + 1) - 1);
		stack = [];
		progTarget = null;
		// у начала книги видна и обложка, что стоит перед первым словом
		setScrollTop(w === 0 ? 0 : (ix.tops[k] ?? 0));
		settledTop = win.scrollTop;
		placeTop = win.scrollTop;
		fill(win.scrollTop);
		fillTop = win.scrollTop;
		updateFoot();
		if (flash) flashHere(w);
	}

	// ---- раскладка

	/** Страницы всех кусков заново: оценка, у кусков в DOM — точные числа. */
	function reestimate(): void {
		pageNums = estimateBookPages(host, chunks, tocSet, pc, geo());
		index();
		for (const l of loaded) pageNums.setMeasured(l.i, Math.max(1, Math.ceil(l.height / H)));
	}

	/** Полная раскладка: геометрия, шрифты, куски вокруг места. Место (anchor) не меняется и не сообщается. */
	async function relayout(): Promise<void> {
		if (disposed) return;
		const seq = ++layoutSeq;
		if (!applyGeometry()) return;
		clearLoaded();
		pageNums = estimateBookPages(host, chunks, tocSet, pc, geo());
		openAt(anchor, false);
		// Шрифт мог ещё не загрузиться: после его прихода строки другие, меряем заново
		if (document.fonts && document.fonts.status === "loading") {
			await document.fonts.ready;
			if (disposed || seq !== layoutSeq) return;
			clearLoaded();
			pageNums = estimateBookPages(host, chunks, tocSet, pc, geo());
			openAt(anchor, false);
		}
		if (highlightNext) {
			highlightNext = false;
			flashHere(anchor);
		}
	}

	/** Перекладывает не чаще кадра: ползунок шлёт десятки событий в секунду, битые рисунки — пачкой; берём последнее значение. */
	function scheduleRelayout(): void {
		if (typeof requestAnimationFrame !== "function") return void relayout();
		if (relayoutFrame) return;
		relayoutFrame = requestAnimationFrame(() => {
			relayoutFrame = 0;
			if (!disposed) void relayout();
		});
	}

	// ---- листание экраном

	/** Идёт прокрутка (наша или пальцем): касание тогда останавливает её, а не листает. */
	function scrolling(): boolean {
		return progTarget !== null || performance.now() - lastScrollAt < SCROLLING_MS;
	}

	/** Экран вперёд или назад. Идущая плавная прокрутка продолжается от её цели. */
	function turn(dir: 1 | -1): void {
		if (disposed || viewer.isOpen() || loaded.length === 0) return;
		// выделение осталось бы на ушедшем экране: закладка взяла бы цитату, которой уже не видно
		pgSel.clear();
		window.getSelection()?.removeAllRanges();
		fill(progTarget ?? win.scrollTop);
		const base = progTarget ?? win.scrollTop;
		const ix = index();
		let t: number;
		let back: number | undefined;
		if (dir === 1) {
			t = nextScreenTop(ix.tops, ix.bottoms, base, H);
		} else {
			const last = stack[stack.length - 1];
			if (last !== undefined && last < base - 0.5) {
				back = last;
				t = last;
			} else t = prevScreenTop(ix.tops, base, H);
		}
		// дальше конца окна не прокрутить
		t = Math.max(0, Math.min(t, content.offsetHeight - H));
		if (dir === 1 ? t <= base + 0.5 : t >= base - 0.5) return;
		if (dir === 1) stack.push(base);
		else if (back !== undefined) stack.pop();
		scrollToTarget(t);
	}

	/** Едет к верху t плавно (или сразу при «уменьшить движение»); куски вокруг цели дописываются до начала движения. */
	function scrollToTarget(t: number): void {
		t += fill(t);
		if (reducedMotion()) {
			progTarget = null;
			setScrollTop(t);
			settledTop = win.scrollTop;
			return;
		}
		progTarget = t;
		win.scrollTo({ top: t, behavior: "smooth" });
	}

	/** Колесо мыши: одна засечка — одна строка. Считается от цели идущей прокрутки, чтобы N засечек давали N строк. */
	function wheelLine(dir: 1 | -1): void {
		if (disposed || viewer.isOpen() || loaded.length === 0) return;
		stack = [];
		fill(progTarget ?? win.scrollTop);
		const base = progTarget ?? win.scrollTop;
		const ix = index();
		let t = dir === 1 ? nextLineTop(ix.tops, base) : prevLineTop(ix.tops, base);
		t = Math.max(0, Math.min(t, content.offsetHeight - H));
		if (Math.abs(t - base) < 0.5) return;
		scrollToTarget(t);
	}

	function onIdle(): void {
		if (disposed) return;
		progTarget = null;
		settledTop = win.scrollTop;
		if (loaded.length === 0) return;
		trim();
		// после уборки места не дописываем: прокрутка стоит, а поправка от убранного куска не повод
		fillTop = win.scrollTop;
		updatePlace();
	}

	win.addEventListener(
		"scroll",
		() => {
			lastScrollAt = performance.now();
			if (progTarget === null) {
				// прокрутка не наша (палец, колесо, клавиши браузера): прежние экраны уже не те
				if (Math.abs(win.scrollTop - settledTop) > 1) stack = [];
			} else if (Math.abs(win.scrollTop - progTarget) < 1) {
				progTarget = null;
				settledTop = win.scrollTop;
			}
			schedulePlace();
			clearTimeout(idleTimer);
			idleTimer = setTimeout(onIdle, IDLE_MS);
		},
		{ passive: true },
	);
	/** Накопленные мелкие дельты тачпада: набралась строка — шаг на строку. */
	let wheelAcc = 0;
	let wheelAt = -1e9;
	win.addEventListener(
		"wheel",
		(e) => {
			// масштаб (Ctrl) и горизонталь — браузеру
			if (e.ctrlKey || e.metaKey || e.deltaY === 0 || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
			e.preventDefault();
			// засечка колеса мыши (строки или крупные пиксели) — ровно строка
			if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= WHEEL_NOTCH_PX) {
				wheelAcc = 0;
				wheelLine(e.deltaY > 0 ? 1 : -1);
				return;
			}
			// тачпад: дельты копятся, строка набралась — шаг; смена направления и пауза обнуляют
			const now = performance.now();
			if (now - wheelAt > WHEEL_PAUSE_MS || Math.sign(wheelAcc) !== Math.sign(e.deltaY)) wheelAcc = 0;
			wheelAt = now;
			wheelAcc += e.deltaY;
			while (Math.abs(wheelAcc) >= lineH) {
				const d = wheelAcc > 0 ? 1 : -1;
				wheelLine(d);
				wheelAcc -= d * lineH;
			}
		},
		{ passive: false },
	);

	// ---- управление
	const onKey = (e: KeyboardEvent) => {
		if (viewer.isOpen() || document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === " " && e.target instanceof HTMLButtonElement) return;
		// стрелки вверх и вниз — по строке
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			wheelLine(e.key === "ArrowDown" ? 1 : -1);
			return;
		}
		let dir = 0;
		if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) dir = -1;
		else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") dir = 1;
		if (!dir) return;
		e.preventDefault();
		turn(dir as 1 | -1);
	};
	document.addEventListener("keydown", onKey);

	let multi = false;
	let tx = 0;
	let ty = 0;
	win.addEventListener(
		"touchstart",
		(e) => {
			multi = e.touches.length > 1;
			tx = e.touches[0].clientX;
			ty = e.touches[0].clientY;
		},
		{ passive: true },
	);
	win.addEventListener(
		"touchmove",
		(e) => {
			if (e.touches.length !== 1) return;
			const dx = e.touches[0].clientX - tx;
			const dy = e.touches[0].clientY - ty;
			// палец ведёт текст вверх-вниз: свои экраны больше не годятся
			if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) {
				progTarget = null;
				stack = [];
			}
		},
		{ passive: true },
	);
	win.addEventListener(
		"touchend",
		(e) => {
			if (multi) {
				if (e.touches.length === 0) multi = false;
				return;
			}
			const t = e.changedTouches[0];
			const dx = t.clientX - tx;
			const dy = t.clientY - ty;
			if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
				swipedAt = performance.now();
				if (!pgSel.has()) turn(dx < 0 ? 1 : -1);
			}
		},
		{ passive: true },
	);

	// Касание, которое остановило прокрутку, не листает: по нажатию запоминаем, шла ли она
	let downAt = -1e9;
	let downScrolling = false;
	win.addEventListener(
		"pointerdown",
		() => {
			downAt = performance.now();
			downScrolling = scrolling();
		},
		{ passive: true },
	);
	win.addEventListener("click", (e) => {
		if (performance.now() - swipedAt < 400) return;
		const stopped = performance.now() - downAt < 1500 ? downScrolling : scrolling();
		if (stopped || pgSel.has()) return;
		const pic = e.target instanceof Element ? e.target.closest("img.pg-img") : null;
		if (pic) {
			const f = loaded.flatMap((l) => l.figs).find((x) => x.img === pic);
			if (f && !disposed) viewer.open(f.idx);
			return;
		}
		const r = win.getBoundingClientRect();
		turn(e.clientX - r.left < r.width / 3 ? -1 : 1);
	});

	// Выделение для закладки: слова кусков в DOM
	const pgSel = createSelection(content, () => loaded.map((l) => ({ fromWord: chunks[l.i].fromWord, spans: l.spans })));

	// Раскладка известна только после вставки в страницу: первый показ делает наблюдатель за размером окна
	const onResize = () => {
		if (win.clientWidth === laidW && win.clientHeight === laidH) return;
		// только высота (панель браузера прячется и появляется): текст не перерисовываем, пока рисунки влезают
		if (win.clientWidth === laidW && laidW > 0 && win.clientHeight > 0) {
			H = win.clientHeight;
			laidH = H;
			const tall = loaded.some((l) => l.figs.some((f) => (f.box.parentElement?.getBoundingClientRect().height ?? 0) > H));
			if (!tall) {
				reestimate();
				updateFoot();
				return;
			}
		}
		void relayout();
	};
	await pc.probeImages();
	let observer: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(onResize);
		observer.observe(win);
	} else window.addEventListener("resize", onResize);
	await document.fonts?.ready;

	const self: ModeView = {
		root: view,
		word,
		seek(w) {
			if (disposed) return;
			anchor = Math.max(0, Math.min(w, Math.max(0, total - 1)));
			if (laidW === 0) {
				highlightNext = true;
				return;
			}
			openAt(anchor, true);
			host.report(anchor);
		},
		pause() {},
		selection() {
			return pgSel.current();
		},
		marksChanged() {
			pgSel.clear();
			for (const l of loaded) paintMarks(l.section, l.spans, chunks[l.i].fromWord, chunks[l.i].toWord, host.bookmarks());
		},
		settingsRows() {
			const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
				s[k] = v;
				host.saveSettings();
				self.applySettings();
			};
			return [
				flowRow(host),
				segmented<FontKind>("Шрифт", s.pageFont, FONT_OPTIONS, (v) => set("pageFont", v)),
				range("Размер текста", s.pageSize, 14, 34, 1, (v) => `${v} px`, (v) => set("pageSize", v)),
				range("Межстрочный интервал", s.lineHeight, 1.2, 2, 0.05, (v) => v.toFixed(2), (v) => set("lineHeight", v)),
				toggle("По ширине", "Выравнивание с переносами слов", s.justify, (v) => set("justify", v)),
			];
		},
		applySettings() {
			scheduleRelayout();
		},
		destroy() {
			disposed = true;
			if (typeof cancelAnimationFrame === "function") {
				if (relayoutFrame) cancelAnimationFrame(relayoutFrame);
				if (placeFrame) cancelAnimationFrame(placeFrame);
			}
			clearTimeout(hereTimer);
			clearTimeout(idleTimer);
			observer?.disconnect();
			window.removeEventListener("resize", onResize);
			document.removeEventListener("keydown", onKey);
			pgSel.destroy();
			viewer.close();
			pc.dispose();
		},
	};
	return self;
}
