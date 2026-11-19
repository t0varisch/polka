import { describe, expect, it } from "vitest";
import { buildWords } from "../core/words";
import type { BookRecord } from "../types";
import { resumeAt, stampUpdated, syncDecision } from "./resume";

const OLD = ["Первая глава начинается здесь", "Вторая глава рассказывает про море и корабли", "Третья глава про горы и долины далеко"];
const NEW = ["Предисловие автора добавили сегодня утром", ...OLD];

function rec(over: Partial<BookRecord> = {}): BookRecord {
	return {
		id: "x",
		title: "т",
		author: "",
		format: "txt",
		wordCount: 0,
		position: { word: 0, para: 0, snippet: "", mode: "pages", at: 1 },
		bookmarks: [],
		typing: { correct: 0, errors: 0, activeMs: 0 },
		addedAt: 1,
		openedAt: 1,
		updatedAt: 100,
		...over,
	};
}

describe("resumeAt", () => {
	const oldStream = buildWords(OLD);
	const newStream = buildWords(NEW);
	const oldWord = oldStream.words.findIndex((w) => w.text === "рассказывает");

	it("число слов то же — ничего не меняется", () => {
		const r = rec({ wordCount: oldStream.words.length, position: { word: oldWord, para: 1, snippet: "рассказывает про море", mode: "pages", at: 1 } });
		const out = resumeAt(oldStream, r, "words");
		expect(out.changed).toBe(false);
		expect(out.start).toBe(oldWord);
		expect(out.position).toBe(r.position);
	});

	it("число слов другое — пишется найденное место, а не старый индекс", () => {
		const r = rec({
			wordCount: oldStream.words.length,
			position: { word: oldWord, para: 1, snippet: "рассказывает про море и корабли", mode: "pages", at: 1 },
			bookmarks: [{ id: "b", word: oldWord, snippet: "рассказывает про море и корабли", createdAt: 5 }],
		});
		const out = resumeAt(newStream, r, "typing", 777);
		const real = newStream.words.findIndex((w) => w.text === "рассказывает");
		expect(real).not.toBe(oldWord);
		expect(out.changed).toBe(true);
		expect(out.start).toBe(real);
		expect(out.position.word).toBe(real);
		expect(out.position.snippet.startsWith("рассказывает")).toBe(true);
		expect(out.position.mode).toBe("typing");
		expect(out.position.at).toBe(777);
		expect(out.bookmarks[0].word).toBe(real);
		expect(out.bookmarks[0].id).toBe("b");
	});
});

describe("syncDecision", () => {
	const mine = { updatedAt: 100, dirty: false };
	it("новее — взять", () => expect(syncDecision(rec({ updatedAt: 101 }), mine)).toBe("adopt"));
	it("равна или старее — оставить", () => {
		expect(syncDecision(rec({ updatedAt: 100 }), mine)).toBe("keep");
		expect(syncDecision(rec({ updatedAt: 50 }), mine)).toBe("keep");
	});
	it("есть несохранённое — оставить", () => expect(syncDecision(rec({ updatedAt: 500 }), { ...mine, dirty: true })).toBe("keep"));
	it("записи нет — оставить", () => expect(syncDecision(null, mine)).toBe("keep"));
});

describe("stampUpdated", () => {
	it("обычно время изменения", () => expect(stampUpdated(500, 100)).toBe(500));
	it("запись из будущего не замораживает сохранения", () => expect(stampUpdated(500, 9000)).toBe(9001));
});
