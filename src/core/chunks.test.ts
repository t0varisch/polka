import { describe, expect, it } from "vitest";
import { buildChunks, chunkOfWord } from "./chunks";
import { buildWords } from "./words";

function book(lens: number[]) {
	const paras = lens.map((n, i) => Array.from({ length: n }, (_, j) => `с${i}_${j}`).join(" "));
	return { stream: buildWords(paras), count: paras.length };
}

describe("buildChunks", () => {
	it("оглавление на 0, 10, 20 — три куска с этими началами", () => {
		const { stream, count } = book(Array(30).fill(50));
		const c = buildChunks(stream, count, [0, 10, 20]);
		expect(c.map((x) => x.fromPara)).toEqual([0, 10, 20]);
		expect(c.map((x) => x.toPara)).toEqual([10, 20, 30]);
	});
	it("без оглавления: 100 абзацев по 120 слов режутся по 5000", () => {
		const { stream, count } = book(Array(100).fill(120));
		const c = buildChunks(stream, count, []);
		expect(c.length).toBeGreaterThan(2);
		for (const x of c) expect(x.toWord - x.fromWord).toBeLessThanOrEqual(5000);
	});
	it("абзац длиннее лимита — один кусок", () => {
		const { stream, count } = book([10, 60, 10]);
		const c = buildChunks(stream, count, [], 50);
		expect(c.map((x) => [x.fromPara, x.toPara])).toEqual([[0, 1], [1, 2], [2, 3]]);
	});
	it("покрытие без дыр и пересечений, пустые абзацы не ломают", () => {
		const { stream, count } = book([5, 0, 7, 0, 0, 9, 4]);
		const c = buildChunks(stream, count, [2, 5], 10);
		expect(c[0].fromPara).toBe(0);
		expect(c[0].fromWord).toBe(0);
		for (let i = 1; i < c.length; i++) {
			expect(c[i].fromPara).toBe(c[i - 1].toPara);
			expect(c[i].fromWord).toBe(c[i - 1].toWord);
		}
		expect(c[c.length - 1].toPara).toBe(count);
		expect(c[c.length - 1].toWord).toBe(stream.words.length);
	});
	it("пустая книга", () => {
		expect(buildChunks(buildWords([]), 0, [])).toEqual([]);
	});
});

describe("chunkOfWord", () => {
	it("на границах", () => {
		const { stream, count } = book(Array(30).fill(50));
		const c = buildChunks(stream, count, [10, 20]);
		expect(chunkOfWord(c, 0)).toBe(0);
		expect(chunkOfWord(c, c[0].toWord - 1)).toBe(0);
		expect(chunkOfWord(c, c[1].fromWord)).toBe(1);
		expect(chunkOfWord(c, c[2].fromWord)).toBe(2);
		expect(chunkOfWord(c, stream.words.length - 1)).toBe(2);
		expect(chunkOfWord(c, stream.words.length + 50)).toBe(2);
		expect(chunkOfWord(c, -3)).toBe(0);
	});
});
