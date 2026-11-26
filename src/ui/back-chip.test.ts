// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACK_CHIP_MS, backLabel, createBackChip } from "./back-chip";

describe("backLabel", () => {
	it("назад со страницей", () => {
		expect(backLabel("back", 12, 30)).toBe("Вернуться на стр. 12");
	});
	it("вперёд со страницей", () => {
		expect(backLabel("forward", 40, 30)).toBe("Обратно на стр. 40");
	});
	it("без страницы — проценты целым", () => {
		expect(backLabel("back", null, 33.6)).toBe("Вернуться на 34%");
	});
});

describe("плашка «Вернуться»", () => {
	let parent: HTMLElement;
	beforeEach(() => {
		vi.useFakeTimers();
		parent = document.createElement("div");
		document.body.append(parent);
	});
	afterEach(() => {
		vi.useRealTimers();
		parent.remove();
	});
	const chipEl = () => parent.querySelector<HTMLElement>(".back-chip");
	const visible = () => {
		const el = chipEl();
		return !!el && !el.hidden;
	};

	it("show показывает подпись, через 10 с плашка скрыта", () => {
		const chip = createBackChip(parent);
		chip.show("Вернуться на стр. 5", () => {});
		expect(visible()).toBe(true);
		expect(chipEl()!.textContent).toContain("Вернуться на стр. 5");
		vi.advanceTimersByTime(BACK_CHIP_MS - 1);
		expect(visible()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(visible()).toBe(false);
	});

	it("пока указатель на плашке, отсчёт стоит; после ухода идёт заново с 10 с", () => {
		const chip = createBackChip(parent);
		chip.show("x", () => {});
		vi.advanceTimersByTime(9000);
		chipEl()!.dispatchEvent(new Event("pointerenter"));
		vi.advanceTimersByTime(20000);
		expect(visible()).toBe(true);
		chipEl()!.dispatchEvent(new Event("pointerleave"));
		vi.advanceTimersByTime(9999);
		expect(visible()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(visible()).toBe(false);
	});

	it("крестик закрывает без onGo", () => {
		const onGo = vi.fn();
		const chip = createBackChip(parent);
		chip.show("x", onGo);
		chipEl()!.querySelector<HTMLElement>(".back-chip-x")!.click();
		expect(visible()).toBe(false);
		expect(onGo).not.toHaveBeenCalled();
	});

	it("клик по подписи вызывает onGo один раз", () => {
		const onGo = vi.fn();
		const chip = createBackChip(parent);
		chip.show("x", onGo);
		chipEl()!.querySelector<HTMLElement>(".back-chip-go")!.click();
		expect(onGo).toHaveBeenCalledTimes(1);
	});

	it("после смахивания следующее нажатие на подпись вызывает onGo", () => {
		const onGo = vi.fn();
		const chip = createBackChip(parent);
		chip.show("x", onGo);
		const el = chipEl()!;
		el.getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
		const fire = (type: string, x: number, t: number) => {
			const e = new Event(type, { bubbles: true });
			Object.defineProperties(e, { pointerId: { value: 1 }, clientX: { value: x }, timeStamp: { value: t } });
			el.dispatchEvent(e);
		};
		// сдвиг на 10 px: больше порога нажатия, меньше порога смахивания (30% от 200)
		fire("pointerdown", 100, 0);
		fire("pointermove", 110, 500);
		fire("pointerup", 110, 1000);
		expect(visible()).toBe(true);
		fire("pointerdown", 100, 2000);
		fire("pointerup", 100, 2050);
		el.querySelector<HTMLElement>(".back-chip-go")!.click();
		expect(onGo).toHaveBeenCalledTimes(1);
	});

	it("второй show заменяет подпись и перезапускает отсчёт", () => {
		const chip = createBackChip(parent);
		chip.show("первая", () => {});
		vi.advanceTimersByTime(9000);
		chip.show("вторая", () => {});
		expect(chipEl()!.textContent).toContain("вторая");
		vi.advanceTimersByTime(9000);
		expect(visible()).toBe(true);
		vi.advanceTimersByTime(1000);
		expect(visible()).toBe(false);
	});

	it("hide скрывает и снимает таймер", () => {
		const chip = createBackChip(parent);
		chip.show("x", () => {});
		chip.hide();
		expect(visible()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("destroy убирает элемент и таймер", () => {
		const chip = createBackChip(parent);
		chip.show("x", () => {});
		chip.destroy();
		expect(chipEl()).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("события плашки не всплывают к режиму", () => {
		const chip = createBackChip(parent);
		chip.show("x", () => {});
		const seen = vi.fn();
		parent.addEventListener("click", seen);
		parent.addEventListener("pointerdown", seen);
		chipEl()!.querySelector<HTMLElement>(".back-chip-go")!.click();
		chipEl()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(seen).not.toHaveBeenCalled();
	});
});
