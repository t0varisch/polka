// Режим «Страницы»: текст кусками по главам, страница — колонка CSS.
// Место в книге — первое слово открытой страницы.
import "./pages.css";
import { buildChunks, chunkOfWord, type Chunk } from "../../core/chunks";
import { fitSize, imagesByChunk } from "../../core/figures";
import type { FontKind, Settings } from "../../settings";
import { formatDuration, h, iconButton } from "../dom";
import { FONT_OPTIONS, range, segmented, toggle } from "../settings-sheet";
import type { ModeFactory, ModeHost, ModeView } from "./types";

/** Скорость для оценки «осталось». */
const READ_WPM = 230;
/** Ширина страницы на широком экране. */
const MAX_PAGE_W = 760;
const WHEEL_GAP_MS = 250;
const SWIPE_PX = 40;
const HERE_MS = 1500;

const FONT_FAMILY: Record<FontKind, string> = {
	serif: '"Literata", Georgia, "Times New Roman", serif',
	sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
	mono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
};

/** Язык для переносов: ru, если среди первых 2000 букв больше кириллицы. */
function detectLang(paragraphs: string[]): "ru" | "en" {
	let letters = 0;
	let cyr = 0;
	for (const p of paragraphs) {
		for (const ch of p) {
			if (!/\p{L}/u.test(ch)) continue;
			letters++;
			if (/[Ѐ-ӿ]/.test(ch)) cyr++;
			if (letters >= 2000) return cyr * 2 > letters ? "ru" : "en";
		}
	}
	return cyr * 2 > letters ? "ru" : "en";
}

export const pagesMode: ModeFactory = async (host: ModeHost, startWord: number): Promise<ModeView> => {
	const s: Settings = host.settings;
	const { stream } = host;
	const total = stream.words.length;
	const tocParas = host.book.toc.map((t) => t.paragraph);
	const tocSet = new Set(tocParas);
	const chunks: Chunk[] = buildChunks(stream, host.book.paragraphs.length, tocParas);
	const lang = detectLang(host.book.paragraphs);
	const images = host.book.images ?? [];
	const imgOfChunk: number[][] = imagesByChunk(chunks, images, host.book.paragraphs.length);
	const chunkOfImg: number[] = [];
	imgOfChunk.forEach((list, ci) => list.forEach((ix) => (chunkOfImg[ix] = ci)));
	/** Размеры рисунков: null — не показывается (не декодировался). */
	const dims: ({ w: number; h: number } | null)[] = images.map((im) => (im.w > 0 && im.h > 0 ? { w: im.w, h: im.h } : null));
	const urls: (string | undefined)[] = [];
	const bad = new Set<number>();

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
	let figs: { idx: number; img: HTMLImageElement }[] = [];
	/** Страницы открытого куска без начала слова. */
	let wordless: boolean[] = [];
	/** Первый рисунок страницы (общий номер) и страница рисунка. */
	let pageFirstImg: number[] = [];
	let pageOfImg = new Map<number, number>();
	/** Общий номер первого рисунка, если открыта страница из одних рисунков; иначе -1. */
	let figAnchor = -1;
	let viewer: HTMLElement | null = null;

	function word(): number {
		return anchor;
	}

	function margin(width: number): number {
		return width < 600 ? 20 : 48;
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
		const m = margin(pageW);
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

	function objectUrl(ix: number): string {
		let u = urls[ix];
		if (!u) {
			const im = images[ix];
			u = URL.createObjectURL(new Blob([im.data as BlobPart], { type: im.mime }));
			urls[ix] = u;
		}
		return u;
	}

	/** Декодирует рисунки с неизвестным размером; не декодировавшиеся не показываются. */
	async function probeImages(): Promise<void> {
		await Promise.all(
			images.map(async (_im, ix) => {
				if (dims[ix]) return;
				try {
					const el = new Image();
					el.src = objectUrl(ix);
					await el.decode();
					if (el.naturalWidth > 0 && el.naturalHeight > 0) dims[ix] = { w: el.naturalWidth, h: el.naturalHeight };
				} catch {
					// битый рисунок пропускаем молча
				}
			}),
		);
	}

	function shown(ix: number): boolean {
		return !!dims[ix] && !bad.has(ix);
	}

	/** Рисунок с размером под колонку; место под подпись оставлено в maxH. */
	function makeFigure(ix: number, cap: HTMLElement | null): HTMLElement {
		const im = images[ix];
		const hasCap = !!cap || !!im.title;
		const d = dims[ix] as { w: number; h: number };
		const maxH = hasCap ? Math.max(3 * lineH, colH - 2 * lineH) : colH;
		const size = fitSize(d.w, d.h, colW, Math.min(maxH, colH));
		const img = h("img.pg-img", { alt: "", draggable: "false" }) as HTMLImageElement;
		img.dataset.i = String(ix);
		img.style.width = `${size.w}px`;
		img.style.height = `${size.h}px`;
		img.addEventListener("error", () => {
			if (disposed || bad.has(ix)) return;
			bad.add(ix);
			void relayout();
		});
		img.src = objectUrl(ix);
		const box = h("div.pg-imgbox", {}, img);
		// Высота блока — целое число строк, но не больше колонки (иначе Chrome уводит картинку в соседнюю колонку)
		const boxH = Math.min(Math.max(1, Math.ceil(size.h / lineH)) * lineH, colH - 0.5);
		box.style.height = `${boxH}px`;
		img.style.marginTop = `${Math.max(0, Math.floor((boxH - size.h) / 2))}px`;
		const fig = h("figure.pg-fig", {}, box);
		if (cap) fig.append(cap);
		else if (im.title) fig.append(h("div.pg-cap", {}, im.title));
		figs.push({ idx: ix, img });
		return fig;
	}

	function renderChunk(i: number): void {
		const c = chunks[i];
		const frag = document.createDocumentFragment();
		spans = new Array(c.toWord - c.fromWord);
		figs = [];
		const mine = (imgOfChunk[i] ?? []).filter(shown);
		const atPara = new Map<number, number[]>();
		for (const ix of mine) {
			const at = Math.min(images[ix].at, c.toPara);
			const l = atPara.get(at);
			if (l) l.push(ix);
			else atPara.set(at, [ix]);
		}
		const paraEl = (p: number, tag: string): HTMLElement | null => {
			const len = stream.paraLens[p] ?? 0;
			if (len === 0) return null;
			const el = h(tag as "p");
			const from = stream.paraStarts[p];
			for (let k = 0; k < len; k++) {
				const sp = h("span", { "data-w": from + k }, stream.words[from + k].text);
				spans[from + k - c.fromWord] = sp;
				if (k > 0) el.append(" ");
				el.append(sp);
			}
			return el;
		};
		for (let p = c.fromPara; p <= c.toPara; p++) {
			let capUsed = false;
			for (const ix of atPara.get(p) ?? []) {
				let cap: HTMLElement | null = null;
				// Абзац-заголовок остаётся заголовком: подписью не становится
				if (!capUsed && images[ix].caption && p < c.toPara && !tocSet.has(p)) {
					cap = paraEl(p, "p.pg-cap");
					if (cap) capUsed = true;
				}
				frag.append(makeFigure(ix, cap));
			}
			if (p === c.toPara || capUsed) continue;
			const el = paraEl(p, tocSet.has(p) ? "h2" : "p");
			if (el) frag.append(el);
		}
		content.replaceChildren(frag);
		chunkIdx = i;
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

	function showPage(k: number): void {
		page = Math.max(0, Math.min(k, firstOf.length - 1));
		content.style.transform = `translateX(${-page * pageW}px)`;
		updateFoot();
	}

	function updateFoot(): void {
		const w = word();
		const pct = (w / Math.max(1, total - 1)) * 100;
		const rest = formatDuration(((total - w) / READ_WPM) * 60000);
		foot.textContent = `стр. ${page + 1} из ${firstOf.length} · ${pct.toFixed(pct < 10 ? 1 : 0)}% · осталось ≈ ${rest}`;
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
		const seq = ++layoutSeq;
		if (!applyGeometry()) return;
		chunkIdx = -1;
		openWord(anchor, false);
		// Шрифт мог ещё не загрузиться: после его прихода колонки другие, меряем заново
		if (document.fonts && document.fonts.status === "loading") {
			await document.fonts.ready;
			if (disposed || seq !== layoutSeq) return;
			chunkIdx = -1;
			openWord(anchor, false);
		}
		if (highlightNext) {
			highlightNext = false;
			flashHere(anchor);
		}
	}

	function turn(dir: 1 | -1): void {
		if (disposed || chunkIdx < 0 || viewer) return;
		if (dir === 1) {
			if (page < firstOf.length - 1) showPage(page + 1);
			else if (chunkIdx < chunks.length - 1) {
				renderChunk(chunkIdx + 1);
				measure();
				showPage(0);
			} else return;
		} else if (page > 0) showPage(page - 1);
		else if (chunkIdx > 0) {
			renderChunk(chunkIdx - 1);
			measure();
			showPage(firstOf.length - 1);
		} else return;
		anchor = firstOf[page];
		figAnchor = wordless[page] ? (pageFirstImg[page] ?? -1) : -1;
		updateFoot();
		host.report(anchor);
	}

	// ---- просмотр рисунка на весь экран
	const onViewerKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopImmediatePropagation();
		closeViewer();
	};
	function closeViewer(): void {
		if (!viewer) return;
		viewer.remove();
		viewer = null;
		window.removeEventListener("keydown", onViewerKey, true);
	}
	function openViewer(ix: number): void {
		if (viewer || disposed) return;
		const img = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
		img.src = objectUrl(ix);
		const close = iconButton("close", "Закрыть", closeViewer, "pg-viewer-close");
		const v = h("div.pg-viewer", { role: "dialog", "aria-label": "Рисунок" }, img, close);
		v.addEventListener("click", closeViewer);
		document.body.append(v);
		viewer = v;
		// Escape в фазе перехвата: оболочка книги его уже не увидит
		window.addEventListener("keydown", onViewerKey, true);
		close.focus({ preventScroll: true });
	}

	// ---- управление
	const onKey = (e: KeyboardEvent) => {
		if (viewer || document.querySelector(".sheet-backdrop")) return;
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
	let lastWheel = 0;
	viewport.addEventListener(
		"wheel",
		(e) => {
			if (e.ctrlKey) return;
			e.preventDefault();
			if (viewer) return;
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
	viewport.addEventListener(
		"touchstart",
		(e) => {
			if (e.touches.length > 1) multi = true;
			else multi = false;
			tx = e.touches[0].clientX;
			ty = e.touches[0].clientY;
		},
		{ passive: true },
	);
	viewport.addEventListener(
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
				turn(dx < 0 ? 1 : -1);
			}
		},
		{ passive: true },
	);

	viewport.addEventListener("click", (e) => {
		if (performance.now() - swipedAt < 400) return;
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed) return;
		const pic = e.target instanceof Element ? e.target.closest("img.pg-img") : null;
		if (pic) {
			const f = figs.find((x) => x.img === pic);
			if (f) openViewer(f.idx);
			return;
		}
		const r = viewport.getBoundingClientRect();
		turn(e.clientX - r.left < r.width / 3 ? -1 : 1);
	});

	document.addEventListener("keydown", onKey);

	// Раскладка известна только после вставки в страницу: первый показ делает наблюдатель за размером окна
	const onResize = () => {
		if (viewport.clientWidth === laidW && viewport.clientHeight === laidH) return;
		void relayout();
	};
	await probeImages();
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
		settingsRows() {
			const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
				s[k] = v;
				host.saveSettings();
				self.applySettings();
			};
			return [
				segmented<FontKind>("Шрифт", s.pageFont, FONT_OPTIONS, (v) => set("pageFont", v)),
				range("Размер текста", s.pageSize, 14, 34, 1, (v) => `${v} px`, (v) => set("pageSize", v)),
				range("Межстрочный интервал", s.lineHeight, 1.2, 2, 0.05, (v) => v.toFixed(2), (v) => set("lineHeight", v)),
				toggle("По ширине", "Выравнивание с переносами слов", s.justify, (v) => set("justify", v)),
			];
		},
		applySettings() {
			// ползунок шлёт десятки событий в секунду: перекладываем не чаще кадра, берём последнее значение
			if (typeof requestAnimationFrame !== "function") return void relayout();
			if (relayoutFrame) return;
			relayoutFrame = requestAnimationFrame(() => {
				relayoutFrame = 0;
				if (!disposed) void relayout();
			});
		},
		destroy() {
			disposed = true;
			if (relayoutFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(relayoutFrame);
			clearTimeout(hereTimer);
			observer?.disconnect();
			window.removeEventListener("resize", onResize);
			document.removeEventListener("keydown", onKey);
			closeViewer();
			for (const u of urls) if (u) URL.revokeObjectURL(u);
			urls.length = 0;
		},
	};
	return self;
};
