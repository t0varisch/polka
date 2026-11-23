import { describe, expect, it } from "vitest";
import { swipeDecision } from "./swipe";

describe("swipeDecision", () => {
	it("сдвиг не меньше порога влево — вперёд", () => {
		expect(swipeDecision(-60, 300, 390, 40)).toBe(1);
	});
	it("сдвиг вправо за порогом — назад", () => {
		expect(swipeDecision(60, 300, 390, 40)).toBe(-1);
	});
	it("короткий медленный сдвиг — вернуть", () => {
		expect(swipeDecision(30, 300, 390, 40)).toBe(0);
	});
	it("быстрый рывок короче порога — листаем", () => {
		expect(swipeDecision(-25, 30, 390, 40)).toBe(1);
		expect(swipeDecision(25, 30, 390, 40)).toBe(-1);
	});
	it("дрожание пальца — не листаем", () => {
		expect(swipeDecision(5, 10, 390, 40)).toBe(0);
		expect(swipeDecision(0, 0, 390, 40)).toBe(0);
	});
	it("скорость ровно 0.5 px/мс — ещё не рывок", () => {
		expect(swipeDecision(-20, 40, 390, 40)).toBe(0);
	});
});
