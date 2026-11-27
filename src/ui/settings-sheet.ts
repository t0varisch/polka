import { type FontKind, type Settings, type Theme, WPM_MAX, WPM_MIN, WPM_STEP } from "../settings";
import { h, openSheet } from "./dom";

export function range(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, set: (v: number) => void): HTMLElement {
	const out = h("output", {}, fmt(value));
	const input = h("input", { type: "range", min, max, step, value, "aria-label": label });
	input.addEventListener("input", () => {
		const v = Number(input.value);
		out.textContent = fmt(v);
		set(v);
	});
	return h("label.row.range-row", {}, h("span.row-label", {}, label, out), input);
}

export function segmented<T extends string | number>(label: string, value: T, options: [T, string][], set: (v: T) => void): HTMLElement {
	const group = h("div.segmented", { role: "radiogroup", "aria-label": label });
	for (const [v, text] of options) {
		const b = h("button", { type: "button", role: "radio", "aria-checked": String(v === value) }, text);
		b.addEventListener("click", () => {
			for (const x of group.children) x.setAttribute("aria-checked", "false");
			b.setAttribute("aria-checked", "true");
			set(v);
		});
		group.append(b);
	}
	return h("div.row", {}, h("span.row-label", {}, label), group);
}

export function toggle(label: string, hint: string, value: boolean, set: (v: boolean) => void): HTMLElement {
	const input = h("input", { type: "checkbox", role: "switch" });
	input.checked = value;
	input.addEventListener("change", () => set(input.checked));
	return h("label.row.toggle-row", {}, h("span.toggle-text", {}, h("span", {}, label), hint ? h("small", {}, hint) : null), input);
}

export const FONT_OPTIONS: [FontKind, string][] = [
	["mono", "Моно"],
	["serif", "С засечками"],
	["sans", "Без засечек"],
];

export function speedRow(s: Settings, set: (v: number) => void): HTMLElement {
	return range("Скорость", s.wpm, WPM_MIN, WPM_MAX, WPM_STEP, (v) => `${v} сл/мин`, set);
}

/**
 * Лист настроек: общий раздел (тема) и строки текущего режима.
 * onChange зовётся после любой правки общего раздела; строки режима сами сообщают о своих правках.
 */
export function openSettings(s: Settings, onChange: (s: Settings) => void, modeRows: HTMLElement[] = [], onClose?: () => void, topRows: HTMLElement[] = []): () => void {
	const body = h(
		"div.settings",
		{},
		...topRows,
		segmented<Theme>(
			"Тема",
			s.theme,
			[["auto", "Авто"], ["light", "Светлая"], ["paper", "Бумага"], ["dark", "Тёмная"], ["black", "Чёрная"]],
			(v) => {
				s.theme = v;
				onChange(s);
			},
		),
		...modeRows,
		h(
			"p.fineprint",
			{},
			"Книги хранятся только у тебя. Красная буква, паузы и звук взяты из ",
			h("a", { href: "https://github.com/sami-29/speeedy", target: "_blank", rel: "noopener" }, "Speeedy"),
			" (лицензия MIT)",
		),
	);
	return openSheet("Настройки", body, onClose);
}
