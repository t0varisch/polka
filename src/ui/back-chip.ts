// Плашка «Вернуться» после прыжка по книге: сама пропадает, закрывается крестиком или смахиванием вбок
import { h, icon } from "./dom";

/** Через сколько плашка пропадает сама. */
export const BACK_CHIP_MS = 10_000;
/** Смахнули дальше этой доли ширины плашки — она уезжает. */
const SWIPE_FRACTION = 0.3;
/** Быстрый рывок: пикселей в миллисекунду. */
const FLING_SPEED = 0.5;
/** Сдвиг, после которого касание считается смахиванием, а не нажатием. */
const DRAG_SLOP = 6;
const LEAVE_MS = 160;

export function backLabel(kind: "back" | "forward", page: number | null, pct: number): string {
	const verb = kind === "back" ? "Вернуться" : "Обратно";
	return page !== null ? `${verb} на стр. ${page}` : `${verb} на ${Math.round(pct)}%`;
}

export function createBackChip(
	parent: HTMLElement,
	opts: { ms?: number } = {},
): { show(label: string, onGo: () => void): void; hide(): void; destroy(): void } {
	const ms = opts.ms ?? BACK_CHIP_MS;
	let onGo: () => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaveTimer: ReturnType<typeof setTimeout> | undefined;
	let held = false;

	const go = h("button.back-chip-go", { type: "button" });
	const close = h("button.back-chip-x", { type: "button", "aria-label": "Закрыть", title: "Закрыть" }, icon("close", 18));
	const el = h("div.back-chip", { role: "status", hidden: true }, go, close);
	parent.append(el);

	function arm(): void {
		clearTimeout(timer);
		timer = held ? undefined : setTimeout(hide, ms);
	}

	function hide(): void {
		clearTimeout(timer);
		clearTimeout(leaveTimer);
		timer = leaveTimer = undefined;
		held = false;
		el.hidden = true;
		el.classList.remove("dragging");
		el.style.transform = "";
		el.style.opacity = "";
	}

	// события плашки не доходят до режима: лента иначе перелистнёт страницу
	for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "mousedown", "mouseup", "dblclick"]) {
		el.addEventListener(type, (e) => e.stopPropagation());
	}
	el.addEventListener("click", (e) => e.stopPropagation());

	el.addEventListener("pointerenter", () => {
		held = true;
		arm();
	});
	el.addEventListener("pointerleave", () => {
		if (drag) return;
		held = false;
		arm();
	});

	// смахивание: плашка идёт за пальцем по X
	let drag: { id: number; x0: number; t0: number; dx: number; moved: boolean } | null = null;
	let suppressClick = false;
	el.addEventListener("pointerdown", (e) => {
		held = true;
		arm();
		// отметка прошлого смахивания не должна съесть это нажатие
		suppressClick = false;
		drag = { id: e.pointerId, x0: e.clientX, t0: e.timeStamp, dx: 0, moved: false };
	});
	el.addEventListener("pointermove", (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		drag.dx = e.clientX - drag.x0;
		if (!drag.moved && Math.abs(drag.dx) > DRAG_SLOP) {
			drag.moved = true;
			el.classList.add("dragging");
			// захват только для смахивания: с самого нажатия он глушит клики мышью по кнопкам
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// без захвата тоже работает: события идут, пока указатель над плашкой
			}
		}
		if (drag.moved) el.style.transform = `translateX(${drag.dx}px)`;
	});
	const release = (e: PointerEvent, cancelled: boolean) => {
		if (!drag || e.pointerId !== drag.id) return;
		const d = drag;
		drag = null;
		held = false;
		if (d.moved) suppressClick = true;
		const width = el.getBoundingClientRect().width || 1;
		const fast = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t0) > FLING_SPEED;
		el.classList.remove("dragging");
		if (d.moved && !cancelled && (Math.abs(d.dx) > width * SWIPE_FRACTION || fast)) {
			// уезжает и закрывается
			el.style.transform = `translateX(${d.dx < 0 ? -1 : 1}00vw)`;
			el.style.opacity = "0";
			clearTimeout(timer);
			timer = undefined;
			clearTimeout(leaveTimer);
			leaveTimer = setTimeout(hide, LEAVE_MS);
			return;
		}
		el.style.transform = "";
		arm();
	};
	el.addEventListener("pointerup", (e) => release(e, false));
	el.addEventListener("pointercancel", (e) => release(e, true));

	go.addEventListener("click", () => {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		try {
			onGo();
		} finally {
			// фокус на кнопке: пробел и Enter иначе нажмут плашку снова вместо листания
			go.blur();
		}
	});
	close.addEventListener("click", () => {
		if (suppressClick) suppressClick = false;
		hide();
	});

	return {
		show(label, cb) {
			onGo = cb;
			go.textContent = label;
			clearTimeout(leaveTimer);
			leaveTimer = undefined;
			drag = null;
			suppressClick = false;
			el.classList.remove("dragging");
			el.style.transform = "";
			el.style.opacity = "";
			el.hidden = false;
			arm();
		},
		hide,
		destroy() {
			hide();
			el.remove();
		},
	};
}
