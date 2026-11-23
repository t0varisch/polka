// Общий код режима «Страницы»: рендер куска, рисунки, подписи, подсветка цитат, выделение для закладки.
// Им пользуются раскладка колонками (pages.ts) и лента: размеры колонки передаются при вызове.
import type { Chunk } from "../../core/chunks";
import { fitSize, imagesByChunk, maxImageHeight, settledWithin } from "../../core/figures";
import { cleanQuote } from "../../core/quote";
import type { BookImage } from "../../types";
import { h } from "../dom";
import type { ModeHost } from "./types";

/** Сколько после снятия выделения оно ещё считается выделением для закладки, мс */
const SEL_KEEP_MS = 2000;
/** Сколько ждать decode() рисунка с неизвестным размером, мс */
const PROBE_TIMEOUT = 4000;

/** Размеры, под которые рисуется кусок: ширина колонки, предельная высота рисунка с подписью и без, высота строки. */
export interface FigGeometry {
	colW: number;
	colH: number;
	lineH: number;
}

/** Рисунок открытого куска: общий номер и элементы. */
export interface Fig {
	idx: number;
	img: HTMLImageElement;
	box: HTMLElement;
	cap: HTMLElement | null;
}

export interface RenderedChunk {
	/** Слова куска: индекс — номер слова минус начало куска. */
	spans: HTMLElement[];
	figs: Fig[];
}

export interface PagesContent {
	images: BookImage[];
	/** Индексы рисунков по кускам и обратно. */
	imgOfChunk: number[][];
	chunkOfImg: number[];
	/** Размеры рисунков: null — не показывается (не декодировался). */
	dims: ({ w: number; h: number } | null)[];
	/** Рисунок показывается: размер известен и браузер его не отверг. */
	shown(ix: number): boolean;
	objectUrl(ix: number): string;
	/** Декодирует рисунки с неизвестным размером; не декодировавшиеся не показываются. */
	probeImages(): Promise<void>;
	/** Рисует кусок i в target (его содержимое заменяется); подписи подогнаны, место для рисунков — по geo. */
	renderChunk(i: number, target: HTMLElement, geo: FigGeometry): RenderedChunk;
	/** Освобождает ссылки на картинки и перестаёт реагировать на их ошибки. */
	dispose(): void;
}

export interface PagesContentOpts {
	host: ModeHost;
	chunks: Chunk[];
	tocSet: Set<number>;
	/** Размер рисунка изменился или рисунок не открылся: раскладку нужно перемерить. */
	onRelayout(): void;
}

/** Подсветка закладок-цитат: слова от word до end каждой закладки с end в куске [fromWord, toWord). */
export function paintMarks(target: HTMLElement, spans: HTMLElement[], fromWord: number, toWord: number, bookmarks: { word: number; end?: number }[]): void {
	for (const el of target.querySelectorAll("span.pg-mark")) el.classList.remove("pg-mark");
	for (const b of bookmarks) {
		if (b.end === undefined || b.end < fromWord || b.word >= toWord) continue;
		for (let w = Math.max(b.word, fromWord); w <= Math.min(b.end, toWord - 1); w++) spans[w - fromWord]?.classList.add("pg-mark");
	}
}

/** Размер картинки и высота блока: целое число строк, но не больше колонки (иначе Chrome уводит картинку в соседнюю колонку). */
function sizeFigure(f: { img: HTMLImageElement; box: HTMLElement }, size: { w: number; h: number }, geo: FigGeometry): void {
	f.img.style.width = `${size.w}px`;
	f.img.style.height = `${size.h}px`;
	const boxH = Math.min(Math.max(1, Math.ceil(size.h / geo.lineH)) * geo.lineH, geo.colH - 0.5);
	f.box.style.height = `${boxH}px`;
	f.img.style.marginTop = `${Math.max(0, Math.floor((boxH - size.h) / 2))}px`;
}

export function createPagesContent(o: PagesContentOpts): PagesContent {
	const { host, chunks, tocSet } = o;
	const { stream } = host;
	const images = host.book.images ?? [];
	const imgOfChunk: number[][] = imagesByChunk(chunks, images, host.book.paragraphs.length);
	const chunkOfImg: number[] = [];
	imgOfChunk.forEach((list, ci) => list.forEach((ix) => (chunkOfImg[ix] = ci)));
	const dims: ({ w: number; h: number } | null)[] = images.map((im) => (im.w > 0 && im.h > 0 ? { w: im.w, h: im.h } : null));
	const urls: (string | undefined)[] = [];
	const bad = new Set<number>();
	let disposed = false;

	function objectUrl(ix: number): string {
		let u = urls[ix];
		if (!u) {
			const im = images[ix];
			u = URL.createObjectURL(new Blob([im.data as BlobPart], { type: im.mime }));
			urls[ix] = u;
		}
		return u;
	}

	async function probeImages(): Promise<void> {
		await Promise.all(
			images.map(async (_im, ix) => {
				if (dims[ix]) return;
				try {
					const el = new Image();
					el.src = objectUrl(ix);
					let fits = false;
					// не дождались decode за срок — рисунок как битый, страницы всё равно запускаются
					const done = await settledWithin(
						el.decode().then(() => {
							fits = el.naturalWidth > 0 && el.naturalHeight > 0;
						}),
						PROBE_TIMEOUT,
					);
					if (done && fits) dims[ix] = { w: el.naturalWidth, h: el.naturalHeight };
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
	function makeFigure(ix: number, cap: HTMLElement | null, geo: FigGeometry, figs: Fig[]): HTMLElement {
		const im = images[ix];
		const hasCap = !!cap || !!im.title;
		const d = dims[ix] as { w: number; h: number };
		const maxH = hasCap ? Math.max(3 * geo.lineH, geo.colH - 2 * geo.lineH) : geo.colH;
		const size = fitSize(d.w, d.h, geo.colW, Math.min(maxH, geo.colH));
		const img = h("img.pg-img", { alt: "", draggable: "false" }) as HTMLImageElement;
		img.dataset.i = String(ix);
		img.style.width = `${size.w}px`;
		img.style.height = `${size.h}px`;
		img.addEventListener("error", () => {
			if (disposed || bad.has(ix)) return;
			bad.add(ix);
			o.onRelayout();
		});
		// EXIF-поворот: браузер показывает JPEG повёрнутым, а размер из файла — до поворота. Берём натуральный.
		img.addEventListener("load", () => {
			if (disposed || bad.has(ix)) return;
			const d = dims[ix];
			const nw = img.naturalWidth;
			const nh = img.naturalHeight;
			if (!d || nw <= 0 || nh <= 0) return;
			if (Math.abs(nw / nh - d.w / d.h) / (d.w / d.h) <= 0.02) return;
			dims[ix] = { w: nw, h: nh };
			o.onRelayout();
		});
		img.src = objectUrl(ix);
		const box = h("div.pg-imgbox", {}, img);
		// Высота блока — целое число строк, но не больше колонки (иначе Chrome уводит картинку в соседнюю колонку)
		const fig = h("figure.pg-fig", {}, box);
		if (cap) fig.append(cap);
		else if (im.title) fig.append(h("div.pg-cap", {}, im.title));
		const f: Fig = { idx: ix, img, box, cap: cap ?? (fig.querySelector(".pg-cap") as HTMLElement | null) };
		sizeFigure(f, size, geo);
		figs.push(f);
		return fig;
	}

	/** Подпись выше резерва в 2 строки: рисунок уменьшается, чтобы вместе с подписью уместиться в колонку. */
	function fitCaptions(figs: Fig[], geo: FigGeometry): void {
		for (const f of figs) {
			if (!f.cap) continue;
			const d = dims[f.idx] as { w: number; h: number };
			const maxH = maxImageHeight(geo.colH, geo.lineH, f.cap.offsetHeight);
			if (maxH === null) continue;
			const size = fitSize(d.w, d.h, geo.colW, maxH);
			if (size.h < f.img.offsetHeight) sizeFigure(f, size, geo);
		}
	}

	function renderChunk(i: number, target: HTMLElement, geo: FigGeometry): RenderedChunk {
		const c = chunks[i];
		const frag = document.createDocumentFragment();
		const spans: HTMLElement[] = new Array(c.toWord - c.fromWord);
		const figs: Fig[] = [];
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
				frag.append(makeFigure(ix, cap, geo, figs));
			}
			if (p === c.toPara || capUsed) continue;
			const el = paraEl(p, tocSet.has(p) ? "h2" : "p");
			if (el) frag.append(el);
		}
		target.replaceChildren(frag);
		fitCaptions(figs, geo);
		return { spans, figs };
	}

	return {
		images,
		imgOfChunk,
		chunkOfImg,
		dims,
		shown,
		objectUrl,
		probeImages,
		renderChunk,
		dispose() {
			disposed = true;
			for (const u of urls) if (u) URL.revokeObjectURL(u);
			urls.length = 0;
		},
	};
}

/** Часть текста на экране: слова одного куска. */
export interface SelPart {
	fromWord: number;
	spans: HTMLElement[];
}

export interface PagesSelection {
	/** Выделение внутри content (или снятое не раньше SEL_KEEP_MS назад): слова от-до и очищенный текст. */
	current(): { from: number; to: number; text: string } | null;
	/** Есть непустое выделение внутри текста книги; чужое выделение на странице не в счёт. */
	has(): boolean;
	/** Забыть запомненное выделение (страница сменилась, подсветка перерисована). */
	clear(): void;
	destroy(): void;
}

/**
 * Выделение для закладки. Кнопка закладки на телефоне снимает выделение раньше, чем срабатывает,
 * поэтому последнее выделение внутри content помнится SEL_KEEP_MS. parts — куски, чьи слова сейчас на экране.
 */
export function createSelection(content: HTMLElement, parts: () => SelPart[]): PagesSelection {
	let lastSel: { range: Range; at: number } | null = null;
	const onSelectionChange = () => {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		if (sel.isCollapsed) return;
		const r = sel.getRangeAt(0);
		lastSel = content.contains(r.commonAncestorContainer) ? { range: r.cloneRange(), at: performance.now() } : null;
	};
	document.addEventListener("selectionchange", onSelectionChange);

	/** Слова, которых касается выделение: от первого до последнего. */
	function wordsOf(r: Range): { from: number; to: number } | null {
		let from = -1;
		let to = -1;
		for (const part of parts()) {
			for (let k = 0; k < part.spans.length; k++) {
				const sp = part.spans[k];
				if (!sp || !r.intersectsNode(sp)) continue;
				// граница выделения ровно на краю слова — слово не считается
				const t = sp.firstChild;
				if (from < 0 && r.startContainer === t && r.startOffset >= (t?.textContent?.length ?? 0)) continue;
				if (r.endContainer === t && r.endOffset === 0) continue;
				if (from < 0) from = part.fromWord + k;
				to = part.fromWord + k;
			}
		}
		return from < 0 ? null : { from, to };
	}

	return {
		current() {
			if (parts().length === 0) return null;
			const sel = window.getSelection();
			let r: Range | null = null;
			if (sel && !sel.isCollapsed && sel.rangeCount > 0 && content.contains(sel.getRangeAt(0).commonAncestorContainer)) r = sel.getRangeAt(0);
			else if (lastSel && performance.now() - lastSel.at <= SEL_KEEP_MS && content.contains(lastSel.range.commonAncestorContainer)) r = lastSel.range;
			if (!r) return null;
			const text = cleanQuote(r.toString());
			const ws = wordsOf(r);
			return text && ws ? { ...ws, text } : null;
		},
		has() {
			const sel = window.getSelection();
			return !!sel && !sel.isCollapsed && !!sel.anchorNode && content.contains(sel.anchorNode);
		},
		clear() {
			lastSel = null;
		},
		destroy() {
			document.removeEventListener("selectionchange", onSelectionChange);
		},
	};
}
