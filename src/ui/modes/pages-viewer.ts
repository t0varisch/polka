// Просмотр рисунка на весь экран: открыть, закрыть, Escape в фазе перехвата.
import { h, iconButton } from "../dom";

export interface FigureViewer {
	open(ix: number): void;
	close(): void;
	isOpen(): boolean;
}

/** objectUrl — ссылка на картинку по общему номеру рисунка. */
export function createFigureViewer(objectUrl: (ix: number) => string): FigureViewer {
	let viewer: HTMLElement | null = null;
	const onViewerKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopImmediatePropagation();
		close();
	};
	function close(): void {
		if (!viewer) return;
		viewer.remove();
		viewer = null;
		window.removeEventListener("keydown", onViewerKey, true);
	}
	function open(ix: number): void {
		if (viewer) return;
		const img = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
		img.src = objectUrl(ix);
		const closeBtn = iconButton("close", "Закрыть", close, "pg-viewer-close");
		const v = h("div.pg-viewer", { role: "dialog", "aria-label": "Рисунок" }, img, closeBtn);
		v.addEventListener("click", close);
		document.body.append(v);
		viewer = v;
		// Escape в фазе перехвата: оболочка книги его уже не увидит
		window.addEventListener("keydown", onViewerKey, true);
		closeBtn.focus({ preventScroll: true });
	}
	return { open, close, isOpen: () => viewer !== null };
}
