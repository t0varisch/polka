// Режим «Печать»: бегущая строка Печатки без статистики клавиш, уроков, верхней панели, навигации и закладок
import "./typing.css";
import { errorSound, keyClick, unlockAudio } from "../../audio";
import { buildTypingMap } from "../../core/anchor";
import {
	buildTypingText,
	layoutHint,
	type MatchOptions,
	matches,
	nextRequired,
	remainingRequired,
	TypingStats,
} from "../../core/typing";
import type { FontKind, Settings } from "../../settings";
import { formatDuration, h, toast } from "../dom";
import { FONT_OPTIONS, range, segmented, toggle } from "../settings-sheet";
import type { ModeFactory, ModeHost, ModeView } from "./types";

/** Сколько символов держать в строке слева и справа от курсора. */
const BEHIND = 80;
const AHEAD = 260;
/** Как часто отдавать накопленные цифры оболочке. */
const SYNC_EVERY_MS = 3000;

function escapeHtml(ch: string): string {
	if (ch === "&") return "&amp;";
	if (ch === "<") return "&lt;";
	if (ch === ">") return "&gt;";
	return ch;
}

export const typingMode: ModeFactory = async (host: ModeHost, startWord: number): Promise<ModeView> => {
	const s: Settings = host.settings;
	const { text, paraStarts } = buildTypingText(host.book.paragraphs);
	const len = text.length;
	const map = buildTypingMap(host.book.paragraphs, host.stream, { text, paraStarts });
	const opts: MatchOptions = { caseSensitive: s.caseSensitive, punctuation: s.punctuation };

	let pos = nextRequired(text, map.wordToChar(startWord), opts);
	let remaining = remainingRequired(text, pos, opts);
	let curWord = map.charToWord(pos);
	const session = new TypingStats();
	// Цифры книги: накопленное раньше плюс эта сессия
	const base = { ...host.book.record.typing };
	let disposed = false;

	// ---- разметка
	const tape = h("div.tape", { "aria-hidden": "true" });
	const tapeWrap = h("div.tape-wrap", {}, h("div.guide.top", {}, h("i")), tape, h("div.guide.bottom", {}, h("i")));
	const hintLine = h("div.type-hint", { "aria-live": "polite" });
	const speedOut = h("b", {}, "—");
	const accOut = h("b", {}, "—");
	const pctOut = h("b", {}, "0%");
	const metaLine = h("div.type-meta");
	const stats = h(
		"div.stats",
		{},
		h("div.stat", {}, speedOut, h("small", {}, "зн/мин")),
		h("div.stat", {}, accOut, h("small", {}, "точность")),
		h("div.stat", {}, pctOut, h("small", {}, "книги")),
	);
	// Невидимое поле ввода: через него приходят буквы и с компьютера, и с экранной клавиатуры телефона
	const input = h("textarea.ghost", {
		"aria-label": "Печатай здесь",
		autocomplete: "off",
		autocorrect: "off",
		autocapitalize: "off",
		spellcheck: "false",
		rows: 1,
	}) as HTMLTextAreaElement;
	const stage = h("main.stage", {}, tapeWrap, hintLine, stats, metaLine);
	const view = h("div.mode-typing", {}, stage, input);

	// ---- бегущая строка
	let winStart = 0;
	let winEnd = 0;
	let anchor = 0;

	function geometry(): void {
		const width = tapeWrap.clientWidth || window.innerWidth;
		anchor = Math.round(width * (width < 768 ? 0.3 : 0.35));
		view.style.setProperty("--anchor", `${anchor}px`);
	}

	function spanAt(i: number): HTMLElement | null {
		return (tape.children[i - winStart] as HTMLElement | undefined) ?? null;
	}

	/** Пропускаемое показываем бледным. */
	function classFor(i: number): string {
		const ch = text[i];
		let c = i < pos ? "done" : i === pos ? "cur" : "";
		if (ch === "\n") c += " para";
		else if (i > pos && nextRequired(text, i, opts) !== i) c += " skip";
		return c.trim();
	}

	function renderWindow(): void {
		winStart = Math.max(0, pos - BEHIND);
		winEnd = Math.min(len, pos + AHEAD);
		let html = "";
		for (let i = winStart; i < winEnd; i++) {
			const ch = text[i];
			const shown = ch === "\n" ? "¶" : escapeHtml(ch);
			const cls = classFor(i);
			html += cls ? `<span class="${cls}">${shown}</span>` : `<span>${shown}</span>`;
		}
		// Конец книги: пустой символ, чтобы курсору было где стоять
		if (winEnd === len) html += `<span class="${pos >= len ? "cur" : ""}"> </span>`;
		view.classList.add("no-anim");
		tape.innerHTML = html;
		place();
		void tape.offsetWidth;
		view.classList.remove("no-anim");
	}

	function place(): void {
		const sp = spanAt(Math.min(pos, winEnd));
		const x = sp ? sp.offsetLeft : 0;
		tape.style.transform = `translateX(${anchor - x}px)`;
	}

	function advance(from: number, to: number): void {
		if (to - winStart > BEHIND * 2 || to > winEnd - 60) {
			renderWindow();
			return;
		}
		for (let i = from; i < to; i++) {
			const sp = spanAt(i);
			if (sp) sp.className = text[i] === "\n" ? "done para" : "done";
		}
		const cur = spanAt(to);
		if (cur) cur.className = text[to] === "\n" ? "cur para" : "cur";
		place();
	}

	/** Сообщает оболочке слово, только когда оно сменилось. */
	function reportWord(): void {
		const w = map.charToWord(pos);
		if (w === curWord) return;
		curWord = w;
		host.report(w);
	}

	// ---- набор
	let hintTimer: ReturnType<typeof setTimeout> | null = null;
	let statsQueued = false;
	let audioReady = false;
	let lastSync = Date.now();
	let finished = pos >= len;

	function setHint(t: string, ms = 0): void {
		hintLine.textContent = t;
		if (hintTimer) clearTimeout(hintTimer);
		hintTimer = ms ? setTimeout(() => refreshHint(), ms) : null;
	}

	// Caps Lock: состояние приходит с любой клавишей, держим подсказку, пока не выключат
	let capsOn = false;
	function readCaps(e: KeyboardEvent): void {
		if (typeof e.getModifierState !== "function") return;
		const on = e.getModifierState("CapsLock");
		if (on === capsOn) return;
		capsOn = on;
		refreshHint();
	}

	function refreshHint(): void {
		if (disposed) return;
		if (pos >= len) return setHint(len ? "Книга напечатана целиком" : "В книге нет текста для печати");
		if (capsOn) return setHint("Включён Caps Lock — выключи");
		if (document.activeElement !== input) return setHint(matchMedia("(pointer: coarse)").matches ? "Нажми на строку, чтобы печатать" : "Нажми любую клавишу, чтобы продолжить");
		setHint(session.correct === 0 ? "Печатай — время пойдёт с первой буквы" : "");
	}

	function press(ch: string): void {
		if (pos >= len) return;
		if (s.typeSound && !audioReady) {
			unlockAudio();
			audioReady = true;
		}
		const expected = text[pos];
		const now = performance.now();
		if (matches(expected, ch, opts)) {
			session.hit(true, now);
			const from = pos;
			pos = nextRequired(text, pos + 1, opts);
			remaining = Math.max(0, remaining - 1);
			advance(from, pos);
			if (s.typeSound) keyClick();
			if (hintLine.textContent) refreshHint();
			reportWord();
			if (pos >= len && !finished) {
				finished = true;
				sync();
				host.flush();
				refreshHint();
				toast("Книга напечатана");
			}
		} else {
			session.hit(false, now);
			const cur = spanAt(pos);
			if (cur) {
				cur.classList.remove("err");
				void cur.offsetWidth;
				cur.classList.add("err");
			}
			if (s.typeSound) errorSound();
			const hint = capsOn ? null : layoutHint(expected, ch);
			if (hint) setHint(hint, 2500);
		}
		if (!statsQueued) {
			statsQueued = true;
			requestAnimationFrame(() => {
				statsQueued = false;
				if (!disposed) updateStats();
			});
		}
		if (Date.now() - lastSync > SYNC_EVERY_MS) sync();
	}

	function typeChars(str: string): void {
		for (const ch of Array.from(str)) press(ch === "\r" ? "\n" : ch);
	}

	let composing = false;
	let consumed = 0;
	input.addEventListener("compositionstart", () => (composing = true));
	input.addEventListener("compositionend", () => {
		composing = false;
		input.value = "";
		consumed = 0;
	});
	input.addEventListener("beforeinput", (e) => {
		if (composing) return;
		if (e.inputType === "insertText" && e.data) {
			e.preventDefault();
			typeChars(e.data);
		} else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
			e.preventDefault();
			typeChars("\n");
		} else if (e.inputType.startsWith("delete")) {
			// Стирать нечего: при ошибке строка стоит и ждёт верную букву
			e.preventDefault();
		}
	});
	// Запасной путь для экранных клавиатур, которые набирают словами (Android)
	input.addEventListener("input", () => {
		const v = input.value;
		if (v.length < consumed) consumed = v.length;
		const fresh = v.slice(consumed);
		consumed = v.length;
		if (fresh) typeChars(fresh);
		if (!composing) {
			input.value = "";
			consumed = 0;
		}
	});
	input.addEventListener("focus", () => (view.classList.add("focused"), refreshHint()));
	input.addEventListener("blur", () => {
		view.classList.remove("focused");
		refreshHint();
		sync();
	});

	const focusInput = () => input.focus({ preventScroll: true });
	stage.addEventListener("click", focusInput);

	// ---- цифры и передача оболочке
	/** Накопленное по книге: база плюс эта сессия. */
	function totals(): { correct: number; errors: number; activeMs: number } {
		return {
			correct: base.correct + session.correct,
			errors: base.errors + session.errors,
			activeMs: base.activeMs + Math.round(session.activeMs),
		};
	}

	function sync(): void {
		lastSync = Date.now();
		if (session.correct + session.errors === 0) return;
		host.updateTyping(totals());
	}

	function bookCpm(): number {
		const t = totals();
		return t.activeMs > 5000 ? Math.round(t.correct / (t.activeMs / 60000)) : 0;
	}

	function updateStats(): void {
		const cpm = session.cpm;
		speedOut.textContent = cpm ? String(cpm) : "—";
		accOut.textContent = session.correct + session.errors ? `${session.accuracy.toFixed(1).replace(".", ",")}%` : "—";
		const pct = len > 1 ? (pos / len) * 100 : 0;
		pctOut.textContent = `${pct.toFixed(pct < 10 ? 1 : 0).replace(".", ",")}%`;
		const avg = bookCpm();
		const speed = cpm || avg;
		const parts: string[] = [];
		if (avg) parts.push(`в среднем по книге ${avg} зн/мин`);
		if (speed) parts.push(`осталось ≈ ${formatDuration((remaining / speed) * 60000)}`);
		else parts.push(`осталось ${remaining.toLocaleString("ru")} знаков`);
		metaLine.textContent = parts.join(" · ");
	}

	function applyLook(): void {
		view.style.setProperty("--type-size", `${s.typeSize}px`);
		geometry();
	}

	// ---- клавиши: режим владеет клавиатурой, начать печатать можно, не попадая в поле
	const onKey = (e: KeyboardEvent) => {
		readCaps(e);
		if (document.querySelector(".sheet-backdrop")) return;
		if (e.key === "Escape") {
			host.goLibrary();
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (document.activeElement !== input && (e.key.length === 1 || e.key === "Enter")) focusInput();
		if (e.key === "Tab") e.preventDefault();
	};
	const onHide = () => {
		if (document.visibilityState === "hidden") {
			sync();
			host.flush();
		}
	};
	const onResize = () => {
		applyLook();
		place();
	};
	document.addEventListener("keydown", onKey);
	document.addEventListener("keyup", readCaps);
	document.addEventListener("visibilitychange", onHide);
	// Раскладка известна только после вставки в страницу: первое размещение ленты делает наблюдатель за размером
	let observer: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(() => {
			if (!disposed) onResize();
		});
		observer.observe(tapeWrap);
	} else window.addEventListener("resize", onResize);

	applyLook();
	await document.fonts?.ready;
	if (!disposed) {
		renderWindow();
		updateStats();
		if (!matchMedia("(pointer: coarse)").matches) focusInput();
		refreshHint();
	}

	const self: ModeView = {
		root: view,
		word: () => map.charToWord(pos),
		seek(word) {
			pos = nextRequired(text, map.wordToChar(word), opts);
			remaining = remainingRequired(text, pos, opts);
			curWord = map.charToWord(pos);
			renderWindow();
			updateStats();
			refreshHint();
			host.report(curWord);
		},
		pause() {
			input.blur();
			sync();
		},
		settingsRows() {
			const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
				s[k] = v;
				host.saveSettings();
				self.applySettings();
			};
			return [
				range("Размер строки", s.typeSize, 18, 64, 2, (v) => `${v} px`, (v) => set("typeSize", v)),
				segmented<FontKind>("Шрифт", s.font, FONT_OPTIONS, (v) => set("font", v)),
				toggle("Звук клавиш", "Тихий щелчок на верную букву и низкий звук на ошибку", s.typeSound, (v) => set("typeSound", v)),
				toggle("Заглавные буквы", "Выключено — регистр не важен", s.caseSensitive, (v) => set("caseSensitive", v)),
				toggle("Знаки препинания", "Выключено — запятые, точки и скобки пропускаются сами", s.punctuation, (v) => set("punctuation", v)),
			];
		},
		applySettings() {
			const changedRules = opts.caseSensitive !== s.caseSensitive || opts.punctuation !== s.punctuation;
			opts.caseSensitive = s.caseSensitive;
			opts.punctuation = s.punctuation;
			if (changedRules) {
				pos = nextRequired(text, pos, opts);
				remaining = remainingRequired(text, pos, opts);
				reportWord();
			}
			applyLook();
			renderWindow();
			updateStats();
		},
		destroy() {
			sync();
			disposed = true;
			if (session.correct >= 100) {
				toast(`Сессия: ${formatDuration(session.activeMs)}, ${session.cpm} зн/мин, точность ${session.accuracy.toFixed(1).replace(".", ",")}%`, 4000);
			}
			if (hintTimer) clearTimeout(hintTimer);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("keyup", readCaps);
			document.removeEventListener("visibilitychange", onHide);
			observer?.disconnect();
			window.removeEventListener("resize", onResize);
		},
	};
	return self;
};
