// Режим «Страницы»: текст кусками по главам, страница — колонка CSS.
// Место в книге — первое слово открытой страницы.
import "./pages.css";
import { buildChunks, chunkOfWord, type Chunk } from "../../core/chunks";
import type { FontKind, Settings } from "../../settings";
import { formatDuration, h } from "../dom";
import { FONT_OPTIONS, range, segmented, toggle } from "../settings-sheet";
import type { ModeFactory, ModeHost, ModeView } from "./types";

/** Скорость для оценки «осталось». */
const READ_WPM = 230;
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

	const content = h("div.pg-content", { lang });
	const viewport = h("div.pg-viewport", {}, content);
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
	/** Слово, на которое надо встать при ближайшей раскладке. */
	let target = Math.max(0, Math.min(startWord, Math.max(0, total - 1)));
	let highlightNext = true;
	let layoutSeq = 0;

	function word(): number {
		return firstOf[page] ?? target;
	}

	function margin(width: number): number {
		return width < 600 ? 20 : 48;
	}

	/** Выставляет размеры колонок под окно; false — окно ещё без размера. */
	function applyGeometry(): boolean {
		const w = viewport.clientWidth;
		const hh = viewport.clientHeight;
		if (w <= 0 || hh <= 0) return false;
		const m = margin(w);
		const lh = s.pageSize * s.lineHeight;
		const padV = 16;
		// Высота — целое число строк: внизу нет обрезанной строки
		const lines = Math.max(1, Math.floor((hh - 2 * padV) / lh));
		pageW = w;
		view.style.setProperty("--pg-font", FONT_FAMILY[s.pageFont]);
		view.style.setProperty("--pg-size", `${s.pageSize}px`);
		view.classList.toggle("justify", s.justify);
		const st = content.style;
		st.lineHeight = `${lh}px`;
		st.width = `${w - 2 * m}px`;
		st.height = `${lines * lh}px`;
		st.columnWidth = `${w - 2 * m}px`;
		st.columnGap = `${2 * m}px`;
		st.marginLeft = `${m}px`;
		st.top = `${Math.floor((hh - lines * lh) / 2)}px`;
		laidW = w;
		laidH = hh;
		return true;
	}

	function renderChunk(i: number): void {
		const c = chunks[i];
		const frag = document.createDocumentFragment();
		spans = new Array(c.toWord - c.fromWord);
		for (let p = c.fromPara; p < c.toPara; p++) {
			const len = stream.paraLens[p] ?? 0;
			if (len === 0) continue;
			const el = h(tocSet.has(p) ? "h2" : "p");
			const from = stream.paraStarts[p];
			for (let k = 0; k < len; k++) {
				const sp = h("span", { "data-w": from + k }, stream.words[from + k].text);
				spans[from + k - c.fromWord] = sp;
				if (k > 0) el.append(" ");
				el.append(sp);
			}
			frag.append(el);
		}
		content.replaceChildren(frag);
		chunkIdx = i;
	}

	/** Страницы слов куска и первое слово каждой страницы. */
	function measure(): void {
		const c = chunks[chunkIdx];
		firstOf = [];
		let last = -1;
		for (let k = 0; k < spans.length; k++) {
			const sp = spans[k];
			if (!sp) continue;
			const pg = Math.max(0, Math.floor(sp.offsetLeft / pageW));
			while (last < pg) {
				last++;
				// Страница без начала слова (очень длинный заголовок) берёт слово предыдущей
				firstOf[last] = last === pg ? c.fromWord + k : (firstOf[last - 1] ?? c.fromWord + k);
			}
		}
		if (firstOf.length === 0) firstOf = [c.fromWord];
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
		const i = chunkOfWord(chunks, w);
		if (i !== chunkIdx) {
			renderChunk(i);
			measure();
		}
		target = w;
		showPage(pageOfWord(w));
		if (highlight) flashHere(w);
	}

	/** Полная раскладка: геометрия, шрифты, измерение. Слово сохраняется. */
	async function relayout(): Promise<void> {
		if (disposed) return;
		const seq = ++layoutSeq;
		const keep = chunkIdx >= 0 ? word() : target;
		if (!applyGeometry()) return;
		chunkIdx = -1;
		openWord(keep, false);
		// Шрифт мог ещё не загрузиться: после его прихода колонки другие, меряем заново
		if (document.fonts && document.fonts.status === "loading") {
			await document.fonts.ready;
			if (disposed || seq !== layoutSeq) return;
			chunkIdx = -1;
			openWord(keep, false);
		}
		if (highlightNext) {
			highlightNext = false;
			flashHere(target);
		}
		host.report(word());
	}

	function turn(dir: 1 | -1): void {
		if (disposed || chunkIdx < 0) return;
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
		target = word();
		host.report(target);
	}

	// ---- управление
	const onKey = (e: KeyboardEvent) => {
		if (document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		let dir = 0;
		if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) dir = -1;
		else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") dir = 1;
		if (!dir) return;
		e.preventDefault();
		turn(dir as 1 | -1);
	};

	let lastWheel = 0;
	viewport.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const now = performance.now();
			if (now - lastWheel < WHEEL_GAP_MS) return;
			const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
			if (d === 0) return;
			lastWheel = now;
			turn(d > 0 ? 1 : -1);
		},
		{ passive: false },
	);

	let swipedAt = -1e9;
	let tx = 0;
	let ty = 0;
	viewport.addEventListener(
		"touchstart",
		(e) => {
			tx = e.touches[0].clientX;
			ty = e.touches[0].clientY;
		},
		{ passive: true },
	);
	viewport.addEventListener(
		"touchend",
		(e) => {
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
		const r = viewport.getBoundingClientRect();
		turn(e.clientX - r.left < r.width / 3 ? -1 : 1);
	});

	document.addEventListener("keydown", onKey);

	// Раскладка известна только после вставки в страницу: первый показ делает наблюдатель за размером окна
	const onResize = () => {
		if (viewport.clientWidth === laidW && viewport.clientHeight === laidH) return;
		void relayout();
	};
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
			target = w;
			if (laidW === 0) {
				highlightNext = true;
				return;
			}
			openWord(w, true);
			host.report(word());
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
			void relayout();
		},
		destroy() {
			disposed = true;
			clearTimeout(hereTimer);
			observer?.disconnect();
			window.removeEventListener("resize", onResize);
			document.removeEventListener("keydown", onKey);
		},
	};
	return self;
};
