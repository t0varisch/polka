// Режим «Страницы»: текст кусками по главам, страница — колонка CSS.
// Место в книге — первое слово открытой страницы.
import "./pages.css";
import { buildChunks, chunkOfWord, type Chunk } from "../../core/chunks";
import { PageNumbers } from "../../core/pagecount";
import { resolveFlow } from "../../core/ribbon";
import { swipeDecision } from "../../core/swipe";
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
	isCoarsePointer,
	MAX_PAGE_W,
	pageMargin,
	paintMarks,
	reducedMotion,
	type Fig,
	type FigGeometry,
} from "./pages-content";
import { createFigureViewer } from "./pages-viewer";
import { ribbonMode } from "./ribbon";
import type { ModeFactory, ModeHost, ModeView } from "./types";

const WHEEL_GAP_MS = 250;
const SWIPE_PX = 40;

/** «Страницы»: раскладка по настройке — колонками или лентой (авто: на телефоне лента). */
export const pagesMode: ModeFactory = (host, startWord) =>
	resolveFlow(host.settings.pageFlow, isCoarsePointer()) === "ribbon" ? ribbonMode(host, startWord) : columnsMode(host, startWord);

const columnsMode: ModeFactory = async (host: ModeHost, startWord: number): Promise<ModeView> => {
	const s: Settings = host.settings;
	const { stream } = host;
	const total = stream.words.length;
	const tocParas = host.book.toc.map((t) => t.paragraph);
	const tocSet = new Set(tocParas);
	const chunks: Chunk[] = buildChunks(stream, host.book.paragraphs.length, tocParas);
	const lang = detectLang(host.book.paragraphs);
	const pc = createPagesContent({ host, chunks, tocSet, onRelayout: () => scheduleRelayout() });
	const { chunkOfImg, shown } = pc;

	const content = h("div.pg-content", { lang });
	const pageBox = h("div.pg-page", {}, content);
	const viewport = h("div.pg-viewport", {}, pageBox);
	const foot = h("footer.pg-foot");
	const view = h("div.mode-pages", {}, viewport, foot);

	let disposed = false;
	let hereTimer: ReturnType<typeof setTimeout> | undefined;
	// Размеры, для которых сделана раскладка; 0 — ещё не измерено
	let laidW = 0;
	let laidH = 0;
	let pageW = 0;
	let chunkIdx = -1;
	let page = 0;
	/** Сдвиг колонок, куда они едут (или стоят). */
	let curX = 0;
	let spans: HTMLElement[] = [];
	/** Первое слово каждой страницы открытого куска (абсолютный номер). */
	let firstOf: number[] = [];
	/** Место в книге: меняется только при листании, seek и входе; раскладка его не трогает. */
	let anchor = Math.max(0, Math.min(startWord, Math.max(0, total - 1)));
	let highlightNext = true;
	let layoutSeq = 0;
	// Размеры колонки (для рисунков) и строки
	let colW = 0;
	let colH = 0;
	let lineH = 0;
	/** Рисунки открытого куска: общий номер и элемент. */
	let figs: Fig[] = [];
	/** Страницы открытого куска без начала слова. */
	let wordless: boolean[] = [];
	/** Первый рисунок страницы (общий номер) и страница рисунка. */
	let pageFirstImg: number[] = [];
	let pageOfImg = new Map<number, number>();
	/** Общий номер первого рисунка, если открыта страница из одних рисунков; иначе -1. */
	let figAnchor = -1;
	const viewer = createFigureViewer(pc.objectUrl);
	/** Сквозная нумерация: оценка по кускам, точное число у измеренных. */
	let pageNums = new PageNumbers(chunks.map(() => 1));

	function word(): number {
		return anchor;
	}

	/** Выставляет размеры колонок под окно; false — окно ещё без размера. */
	function applyGeometry(): boolean {
		const w = viewport.clientWidth;
		const hh = viewport.clientHeight;
		if (w <= 0 || hh <= 0) return false;
		const lh = s.pageSize * s.lineHeight;
		lineH = lh;
		const padV = 16;
		// Высота — целое число строк: внизу нет обрезанной строки
		const lines = Math.max(1, Math.floor((hh - 2 * padV) / lh));
		pageW = Math.min(w, MAX_PAGE_W);
		const off = Math.floor((w - pageW) / 2);
		const m = pageMargin(pageW);
		view.style.setProperty("--pg-font", FONT_FAMILY[s.pageFont]);
		view.style.setProperty("--pg-size", `${s.pageSize}px`);
		// Подпись под рисунком — другого рода шрифт, чем основной текст
		view.style.setProperty("--pg-cap-font", s.pageFont === "serif" ? FONT_FAMILY.sans : FONT_FAMILY.serif);
		view.style.setProperty("--pg-cap-style", s.pageFont === "serif" ? "normal" : "italic");
		view.classList.toggle("justify", s.justify);
		const st = content.style;
		st.lineHeight = `${lh}px`;
		st.width = `${pageW - 2 * m}px`;
		st.height = `${lines * lh}px`;
		st.columnWidth = `${pageW - 2 * m}px`;
		st.columnGap = `${2 * m}px`;
		st.marginLeft = `${m}px`;
		colW = pageW - 2 * m;
		colH = lines * lh;
		pageBox.style.left = `${off}px`;
		pageBox.style.width = `${pageW}px`;
		st.top = `${Math.floor((hh - lines * lh) / 2)}px`;
		laidW = w;
		laidH = hh;
		return true;
	}

	/** Оценка страниц всех кусков под текущую геометрию; точные числа сбрасываются. */
	function estimatePages(): void {
		pageNums = estimateBookPages(host, chunks, tocSet, pc, geo());
	}

	function geo(): FigGeometry {
		return { colW, colH, lineH };
	}

	function renderChunk(i: number): void {
		const r = pc.renderChunk(i, content, geo());
		spans = r.spans;
		figs = r.figs;
		chunkIdx = i;
		repaintMarks();
	}

	/** Подсветка закладок-цитат открытого куска. */
	function repaintMarks(): void {
		const c = chunks[chunkIdx];
		if (c) paintMarks(content, spans, c.fromWord, c.toWord, host.bookmarks());
		else for (const el of content.querySelectorAll("span.pg-mark")) el.classList.remove("pg-mark");
	}

	/** Страницы куска (слова и рисунки), первое слово каждой страницы. */
	function measure(): void {
		const c = chunks[chunkIdx];
		const own: (number | undefined)[] = [];
		let pages = 0;
		for (let k = 0; k < spans.length; k++) {
			const sp = spans[k];
			if (!sp) continue;
			const pg = Math.max(0, Math.floor(sp.offsetLeft / pageW));
			if (own[pg] === undefined) own[pg] = c.fromWord + k;
			pages = Math.max(pages, pg + 1);
		}
		pageFirstImg = [];
		pageOfImg = new Map();
		for (const f of figs) {
			const pg = Math.max(0, Math.floor(f.img.offsetLeft / pageW));
			pageOfImg.set(f.idx, pg);
			if (pageFirstImg[pg] === undefined) pageFirstImg[pg] = f.idx;
			pages = Math.max(pages, pg + 1);
		}
		if (pages === 0) pages = 1;
		// Страница без начала слова берёт первое слово после неё; дальше слов нет — конец куска
		let next = c.toWord < total ? c.toWord : total - 1;
		firstOf = new Array(pages);
		wordless = new Array(pages);
		pageNums.setMeasured(chunkIdx, pages);
		for (let p = pages - 1; p >= 0; p--) {
			wordless[p] = own[p] === undefined;
			if (own[p] !== undefined) next = own[p] as number;
			firstOf[p] = next;
		}
	}

	function pageOfWord(w: number): number {
		let lo = 0;
		let hi = firstOf.length - 1;
		let res = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (firstOf[mid] <= w) {
				res = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		// Страница из одних рисунков в конце куска слов не содержит
		while (res > 0 && wordless[res]) res--;
		return res;
	}

	/** Сдвиг пальца к моменту отпускания: добавляется к началу въезда нового куска. */
	let enterShift = 0;

	/** Ставит сдвиг колонок: с анимацией (transition из CSS) или сразу. */
	function setX(x: number, animate: boolean): void {
		curX = x;
		const st = content.style;
		if (animate && !reducedMotion()) {
			st.transition = "";
		} else {
			st.transition = "none";
			st.transform = `translateX(${x}px)`;
			void content.offsetWidth; // применить без перехода
			st.transition = "";
			return;
		}
		st.transform = `translateX(${x}px)`;
	}

	/** Открывает страницу; slide — съехать с текущего места, enter — кусок въезжает с края (1 справа, -1 слева). */
	function showPage(k: number, slide = false, enter: 0 | 1 | -1 = 0): void {
		page = Math.max(0, Math.min(k, firstOf.length - 1));
		const x = -page * pageW;
		// при листании пальцем новый кусок въезжает от места, где был палец
		if (enter && slide) setX(x + enter * pageW + enterShift, false);
		setX(x, slide);
		updateFoot();
	}

	function updateFoot(): void {
		foot.textContent = footText(pageNums.startOf(chunkIdx) + page + 1, pageNums.total, word(), total);
	}

	function flashHere(w: number): void {
		content.querySelector("span.here")?.classList.remove("here");
		clearTimeout(hereTimer);
		const c = chunks[chunkIdx];
		const sp = c ? spans[w - c.fromWord] : undefined;
		if (!sp) return;
		sp.classList.add("here");
		hereTimer = setTimeout(() => sp.classList.remove("here"), HERE_MS);
	}

	/** Открыть слово: кусок, страница, при необходимости подсветка. */
	function openWord(w: number, highlight: boolean): void {
		if (chunks.length === 0) return;
		w = Math.max(0, Math.min(w, total - 1));
		let i = chunkOfWord(chunks, w);
		// Открыта страница из одних рисунков: остаёмся на странице с тем же первым рисунком
		if (figAnchor >= 0 && shown(figAnchor) && chunkOfImg[figAnchor] !== undefined) i = chunkOfImg[figAnchor];
		else figAnchor = -1;
		if (i !== chunkIdx) {
			renderChunk(i);
			measure();
		}
		let pg = pageOfWord(w);
		if (figAnchor >= 0) {
			const p = pageOfImg.get(figAnchor);
			if (p !== undefined) {
				pg = p;
				if (!wordless[p]) figAnchor = -1;
			} else figAnchor = -1;
		}
		showPage(pg);
		if (highlight) flashHere(w);
	}

	/** Полная раскладка: геометрия, шрифты, измерение. Место (anchor) не меняется и не сообщается. */
	async function relayout(): Promise<void> {
		if (disposed) return;
		// поворот экрана посреди ведения: старый сдвиг пальца уже не годится
		dragging = false;
		content.style.transition = "";
		const seq = ++layoutSeq;
		if (!applyGeometry()) return;
		estimatePages();
		chunkIdx = -1;
		openWord(anchor, false);
		// Шрифт мог ещё не загрузиться: после его прихода колонки другие, меряем заново
		if (document.fonts && document.fonts.status === "loading") {
			await document.fonts.ready;
			if (disposed || seq !== layoutSeq) return;
			estimatePages();
			chunkIdx = -1;
			openWord(anchor, false);
		}
		if (highlightNext) {
			highlightNext = false;
			flashHere(anchor);
		}
	}

	/** Есть ли куда листать в эту сторону. */
	function canTurn(dir: 1 | -1): boolean {
		if (chunkIdx < 0) return false;
		return dir === 1 ? page < firstOf.length - 1 || chunkIdx < chunks.length - 1 : page > 0 || chunkIdx > 0;
	}

	function turn(dir: 1 | -1): void {
		if (disposed || chunkIdx < 0 || viewer.isOpen() || !canTurn(dir)) return;
		// выделение осталось бы на ушедшей странице: закладка взяла бы цитату, которой на экране нет
		pgSel.clear();
		window.getSelection()?.removeAllRanges();
		if (dir === 1) {
			if (page < firstOf.length - 1) showPage(page + 1, true);
			else if (chunkIdx < chunks.length - 1) {
				renderChunk(chunkIdx + 1);
				measure();
				showPage(0, true, 1);
			} else return;
		} else if (page > 0) showPage(page - 1, true);
		else if (chunkIdx > 0) {
			renderChunk(chunkIdx - 1);
			measure();
			showPage(firstOf.length - 1, true, -1);
		} else return;
		anchor = firstOf[page];
		figAnchor = wordless[page] ? (pageFirstImg[page] ?? -1) : -1;
		updateFoot();
		host.report(anchor);
	}

	// ---- управление
	const onKey = (e: KeyboardEvent) => {
		if (viewer.isOpen() || document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === " " && e.target instanceof HTMLButtonElement) return;
		let dir = 0;
		if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) dir = -1;
		else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") dir = 1;
		if (!dir) return;
		e.preventDefault();
		turn(dir as 1 | -1);
	};

	let relayoutFrame = 0;
	/** Перекладывает не чаще кадра: ползунок шлёт десятки событий в секунду, битые рисунки — пачкой; берём последнее значение. */
	function scheduleRelayout(): void {
		if (typeof requestAnimationFrame !== "function") return void relayout();
		if (relayoutFrame) return;
		relayoutFrame = requestAnimationFrame(() => {
			relayoutFrame = 0;
			if (!disposed) void relayout();
		});
	}
	let lastWheel = 0;
	viewport.addEventListener(
		"wheel",
		(e) => {
			if (e.ctrlKey) return;
			e.preventDefault();
			if (viewer.isOpen()) return;
			// время обновляем на каждое событие: инерция тачпада тянется дольше паузы, и один жест — одна страница
			const now = performance.now();
			const quiet = now - lastWheel >= WHEEL_GAP_MS;
			lastWheel = now;
			if (!quiet) return;
			const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
			if (d === 0) return;
			turn(d > 0 ? 1 : -1);
		},
		{ passive: false },
	);

	let swipedAt = -1e9;
	let multi = false;
	let tx = 0;
	let ty = 0;
	let tStart = 0;
	/** Палец ведёт страницу: колонки идут за ним без анимации. */
	let dragging = false;
	let dragBase = 0;
	const hasSelection = (): boolean => pgSel.has();
	/** Где колонки сейчас на экране (в разгар анимации — не там, куда едут). */
	function visualX(): number {
		try {
			const m = new DOMMatrix(getComputedStyle(content).transform);
			return Number.isFinite(m.m41) ? m.m41 : curX;
		} catch {
			return curX;
		}
	}
	/** Палец отпущен или отменён: страница доезжает или возвращается; место — по логической странице. */
	function endDrag(dx: number, ms: number, cancel: boolean): void {
		dragging = false;
		swipedAt = performance.now();
		const dir = cancel || hasSelection() ? 0 : swipeDecision(dx, ms, pageW, SWIPE_PX);
		content.style.transition = "";
		if (dir !== 0) {
			// сдвиг пальца относительно положения страницы до подмены куска
			enterShift = visualX() - curX;
			turn(dir);
			enterShift = 0;
		}
		// не долистали (порог, край книги, просмотр рисунка): вернуть на место
		setX(curX, true);
	}
	viewport.addEventListener(
		"touchstart",
		(e) => {
			multi = e.touches.length > 1;
			tx = e.touches[0].clientX;
			ty = e.touches[0].clientY;
			tStart = performance.now();
			// второй палец или новое касание посреди ведения — отпускаем страницу
			if (dragging) endDrag(0, 1, true);
		},
		{ passive: true },
	);
	viewport.addEventListener(
		"touchmove",
		(e) => {
			if (multi || viewer.isOpen() || chunkIdx < 0 || reducedMotion() || e.touches.length !== 1) return;
			const dx = e.touches[0].clientX - tx;
			const dy = e.touches[0].clientY - ty;
			if (!dragging) {
				// ведём только явно горизонтальное движение; выделение текста не трогаем
				if (Math.abs(dx) <= 8 || Math.abs(dx) <= Math.abs(dy) || hasSelection()) return;
				dragging = true;
				dragBase = visualX();
				content.style.transition = "none";
			}
			// у края книги — с сопротивлением: втрое меньше пальца
			// порог 8 px вычитаем: страница не прыгает в начале ведения
			const eff = dx - Math.sign(dx) * 8;
			const x = dragBase + (canTurn(dx < 0 ? 1 : -1) ? eff : eff / 3);
			content.style.transform = `translateX(${x}px)`;
		},
		{ passive: true },
	);
	viewport.addEventListener(
		"touchend",
		(e) => {
			if (multi) {
				if (e.touches.length === 0) multi = false;
				if (dragging) endDrag(0, 1, true);
				return;
			}
			const t = e.changedTouches[0];
			const dx = t.clientX - tx;
			const dy = t.clientY - ty;
			if (dragging) return endDrag(dx, performance.now() - tStart, false);
			if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
				swipedAt = performance.now();
				if (!hasSelection()) turn(dx < 0 ? 1 : -1);
			}
		},
		{ passive: true },
	);
	viewport.addEventListener(
		"touchcancel",
		() => {
			multi = false;
			if (dragging) endDrag(0, 1, true);
		},
		{ passive: true },
	);

	viewport.addEventListener("click", (e) => {
		if (performance.now() - swipedAt < 400) return;
		if (hasSelection()) return;
		const pic = e.target instanceof Element ? e.target.closest("img.pg-img") : null;
		if (pic) {
			const f = figs.find((x) => x.img === pic);
			if (f && !disposed) viewer.open(f.idx);
			return;
		}
		const r = viewport.getBoundingClientRect();
		turn(e.clientX - r.left < r.width / 3 ? -1 : 1);
	});

	document.addEventListener("keydown", onKey);

	// Выделение для закладки: слова открытого куска
	const pgSel = createSelection(content, () => {
		const c = chunks[chunkIdx];
		return c ? [{ fromWord: c.fromWord, spans }] : [];
	});

	// Раскладка известна только после вставки в страницу: первый показ делает наблюдатель за размером окна
	const onResize = () => {
		if (viewport.clientWidth === laidW && viewport.clientHeight === laidH) return;
		void relayout();
	};
	await pc.probeImages();
	let observer: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(onResize);
		observer.observe(viewport);
	} else window.addEventListener("resize", onResize);
	await document.fonts?.ready;

	const self: ModeView = {
		root: view,
		word,
		seek(w) {
			if (disposed) return;
			anchor = Math.max(0, Math.min(w, Math.max(0, total - 1)));
			figAnchor = -1;
			if (laidW === 0) {
				highlightNext = true;
				return;
			}
			openWord(anchor, true);
			host.report(anchor);
		},
		pause() {},
		selection() {
			return pgSel.current();
		},
		marksChanged() {
			pgSel.clear();
			repaintMarks();
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
			if (relayoutFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(relayoutFrame);
			clearTimeout(hereTimer);
			observer?.disconnect();
			window.removeEventListener("resize", onResize);
			document.removeEventListener("keydown", onKey);
			pgSel.destroy();
			viewer.close();
			pc.dispose();
		},
	};
	return self;
};
