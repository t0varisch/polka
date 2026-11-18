import { h } from "../dom";
import type { ModeFactory } from "./types";

/** Заглушка режима, который ещё не сделан: показывает «Скоро» и держит слово без изменений. */
export function stubMode(name: string): ModeFactory {
	return async (host, startWord) => {
		const root = h("div.mode-stub", {}, h("p", {}, `${name}: скоро`));
		host.report(startWord);
		return {
			root,
			word: () => startWord,
			seek: (w) => {
				startWord = w;
				host.report(w);
			},
			pause() {},
			settingsRows: () => [],
			applySettings() {},
			destroy() {},
		};
	};
}
