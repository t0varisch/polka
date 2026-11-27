import { describe, expect, it } from "vitest";
import { upgradeDb } from "./db";

function fakeDb() {
	const created: string[] = [];
	return { created, d: { createObjectStore: (name: string) => void created.push(name) } };
}

describe("upgradeDb", () => {
	it("с нуля создаёт все четыре хранилища", () => {
		const { created, d } = fakeDb();
		upgradeDb(d, 0);
		expect(created).toEqual(["books", "texts", "handles", "files"]);
	});
	it("с версии 1 добавляет только files", () => {
		const { created, d } = fakeDb();
		upgradeDb(d, 1);
		expect(created).toEqual(["files"]);
	});
});
