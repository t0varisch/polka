import { afterEach, describe, expect, it } from "vitest";
import { createSelection, pageMargin, type SelPart } from "./pages-content";

/** Два куска лежат в одном контейнере, как в ленте: слова 10-12 и 13-14. */
function setup(): { content: HTMLElement; parts: SelPart[]; spans: HTMLElement[] } {
	const content = document.createElement("div");
	const mk = (from: number, words: string[]): SelPart => {
		const section = document.createElement("section");
		const p = document.createElement("p");
		const spans = words.map((t, k) => {
			const sp = document.createElement("span");
			sp.dataset.w = String(from + k);
			sp.textContent = t;
			return sp;
		});
		spans.forEach((sp, k) => {
			if (k > 0) p.append(" ");
			p.append(sp);
		});
		section.append(p);
		content.append(section);
		return { fromWord: from, spans };
	};
	const parts = [mk(10, ["один", "два", "три"]), mk(13, ["four", "five"])];
	document.body.append(content);
	return { content, parts, spans: parts.flatMap((p) => p.spans) };
}

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

describe("createSelection: несколько кусков", () => {
	it("выделение через границу кусков: from в первом, to во втором", () => {
		const { content, parts, spans } = setup();
		const sel = createSelection(content, () => parts);
		const r = document.createRange();
		r.setStart(spans[2].firstChild as Text, 1); // «три», внутри слова
		r.setEnd(spans[3].firstChild as Text, 2); // «four», внутри слова
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(r);
		const cur = sel.current();
		expect(cur?.from).toBe(12);
		expect(cur?.to).toBe(13);
		expect(cur?.text).toBe("риfo");
		sel.destroy();
	});

	it("выделение внутри второго куска считается от его начала", () => {
		const { content, parts, spans } = setup();
		const sel = createSelection(content, () => parts);
		const r = document.createRange();
		r.selectNodeContents(spans[4]);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(r);
		expect(sel.current()).toMatchObject({ from: 14, to: 14 });
		sel.destroy();
	});

	it("нет кусков в DOM — выделения нет", () => {
		const { content, spans } = setup();
		const sel = createSelection(content, () => []);
		const r = document.createRange();
		r.selectNodeContents(spans[0]);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(r);
		expect(sel.current()).toBeNull();
		sel.destroy();
	});
});

describe("pageMargin", () => {
	it("поля по ширине и настройке", () => {
		expect(pageMargin(390, "narrow")).toBe(12);
		expect(pageMargin(390)).toBe(20);
		expect(pageMargin(1280, "wide")).toBe(96);
		expect(pageMargin(1280)).toBe(48);
	});
});
