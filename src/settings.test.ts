import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadSettings } from "./settings";

describe("loadSettings", () => {
	beforeEach(() => localStorage.clear());

	it("убранная настройка «Листание» в хранилище читается без ошибок и ничего не меняет", () => {
		localStorage.setItem("polka:settings", JSON.stringify({ ["page" + "Flow"]: "pages", pageSize: 25 }));
		const s = loadSettings();
		expect(s.pageSize).toBe(25);
		expect(s.pageFont).toBe(DEFAULTS.pageFont);
		expect(s.lineHeight).toBe(DEFAULTS.lineHeight);
	});

	it("старые настройки получают абзац и поля по умолчанию", () => {
		localStorage.setItem("polka:settings", JSON.stringify({ pageSize: 25 }));
		const s = loadSettings();
		expect(s.paraGap).toBe(0);
		expect(s.indent).toBe(1.4);
		expect(s.margins).toBe("normal");
	});
});
