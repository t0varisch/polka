// Режим «По слову»: экран Точки без верхней панели, навигации и закладок
import { tick, unlockAudio } from "../../audio";
import { splitOrp } from "../../core/orp";
import { Player } from "../../core/player";
import { buildWords, type PauseLevel, type Word, type WordStream } from "../../core/words";
import { type FontKind, type Settings, WPM_MAX, WPM_MIN, WPM_STEP } from "../../settings";
import { formatDuration, h, icon, iconButton, toast } from "../dom";
import { FONT_OPTIONS, range, segmented, speedRow, toggle } from "../settings-sheet";
import type { ModeFactory, ModeHost, ModeView } from "./types";

/** Разбивка на слова, собранная для обычного уровня пауз, — общая на книгу. */
const SHARED_LEVEL: PauseLevel = 2;

/** Ставит слово так, чтобы красная буква была ровно на засечке; длинные слова ужимает по ширине. */
function placeWord(el: HTMLElement, text: string, fontPx: number, anchor: number, width: number): void {
	const parts = splitOrp(text);
	const [b, p, a] = el.children as unknown as HTMLElement[];
	b.textContent = parts.before;
	p.textContent = parts.pivot;
	a.textContent = parts.after;
	el.style.fontSize = `${fontPx}px`;
	const pc = p.offsetLeft + p.offsetWidth / 2;
	const total = el.offsetWidth;
	const margin = 10;
	let scale = 1;
	if (pc > 0 && total > 0) {
		scale = Math.min(1, (anchor - margin) / pc, (width - anchor - margin) / Math.max(1, total - pc));
	}
	if (scale < 1) el.style.fontSize = `${fontPx * scale}px`;
	el.style.transform = `translateX(${anchor - pc * scale}px)`;
}

function wordEl(cls: string): HTMLElement {
	return h(`div.${cls}` as "div", {}, h("span.b"), h("span.p"), h("span.a"));
}

type Sentinel = { release(): Promise<void>; addEventListener(t: "release", f: () => void): void };

export const wordsMode: ModeFactory = async (host: ModeHost, startWord: number): Promise<ModeView> => {
	const s: Settings = host.settings;
	// Разбивка на слова от уровня пауз не зависит, меняются только веса пауз
	let level: PauseLevel = s.pauses;
	let stream: WordStream = level === SHARED_LEVEL ? host.stream : buildWords(host.book.paragraphs, level);

	const playBtn = h("button.play", { type: "button", "aria-label": "Читать" }, icon("play", 30));
	const wpmOut = h("div.wpm", { "aria-label": "Скорость" });
	const metaLine = h("div.meta");
	const word = wordEl("word");
	const prevWord = wordEl("ctx-word.prev");
	const nextWord = wordEl("ctx-word.next");
	const focus = h("div.focus", {}, h("div.guide.top", {}, h("i")), word, h("div.guide.bottom", {}, h("i")));
	const stage = h("main.stage", { "aria-live": "off" }, prevWord, focus, nextWord);
	const pauseView = h("section.pause-view", { "aria-label": "Текст вокруг" });

	const view = h(
		"div.mode-words",
		{},
		stage,
		pauseView,
		h(
			"footer.controls",
			{},
			h(
				"div.control-row",
				{},
				iconButton("prev", "Назад на предложение", () => player.backSentence()),
				playBtn,
				iconButton("next", "Вперёд на предложение", () => player.forwardSentence()),
				h("div.speed", {}, iconButton("minus", "Медленнее", () => changeWpm(-WPM_STEP)), wpmOut, iconButton("plus", "Быстрее", () => changeWpm(WPM_STEP))),
			),
			metaLine,
		),
	);

	let wakeLock: Sentinel | null = null;
	let disposed = false;
	let wasPlaying = false;
	let appliedAnchor = -1;

	const player = new Player(stream, { wpm: s.wpm, smart: s.smart, ramp: s.ramp }, onWord, onState);
	player.index = Math.max(0, Math.min(startWord, stream.words.length - 1));

	/** Ширина сцены и положение засечки; засечка в CSS всегда совпадает с той, по которой ставится слово. */
	function geometry(): { width: number; anchor: number } {
		const width = stage.clientWidth || window.innerWidth;
		const anchor = Math.round(width * (width < 768 ? 0.4 : 0.45));
		if (anchor !== appliedAnchor) {
			appliedAnchor = anchor;
			view.style.setProperty("--anchor", `${anchor}px`);
		}
		return { width, anchor };
	}

	function onWord(i: number, w: Word): void {
		if (disposed) return;
		const { width, anchor } = geometry();
		placeWord(word, w.text, s.wordSize, anchor, width);
		if (s.context) {
			const small = Math.max(14, Math.round(s.wordSize * 0.42));
			const pw = player.words[i - 1];
			const nw = player.words[i + 1];
			prevWord.style.visibility = pw ? "visible" : "hidden";
			nextWord.style.visibility = nw ? "visible" : "hidden";
			if (pw) placeWord(prevWord, pw.text, small, anchor, width);
			if (nw) placeWord(nextWord, nw.text, small, anchor, width);
		}
		if (player.playing) {
			if (s.sound) tick(w.end ? "end" : w.pause > 1.3 ? "comma" : "word");
			if ((i & 7) === 0) updateMeta();
		}
		host.report(i);
	}

	function onState(): void {
		if (disposed) return;
		const finished = wasPlaying && !player.playing && player.index >= player.words.length - 1;
		wasPlaying = player.playing;
		view.dataset.playing = String(player.playing);
		playBtn.replaceChildren(icon(player.playing ? "pause" : "play", 30));
		playBtn.setAttribute("aria-label", player.playing ? "Пауза" : "Читать");
		wpmOut.textContent = `${player.opts.wpm} сл/мин`;
		updateMeta();
		if (player.playing) {
			pauseView.replaceChildren();
			lockScreen();
		} else {
			renderPauseView();
			host.flush();
			unlockScreen();
			if (finished) toast("Книга дочитана");
		}
	}

	function updateMeta(): void {
		const n = player.words.length;
		const pct = n > 1 ? (player.index / (n - 1)) * 100 : 0;
		metaLine.textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% · осталось ${formatDuration(player.remainingMs())}`;
	}

	function changeWpm(delta: number): void {
		const v = Math.min(WPM_MAX, Math.max(WPM_MIN, player.opts.wpm + delta));
		s.wpm = v;
		host.saveSettings();
		player.setWpm(v);
	}

	// ---- текст вокруг на паузе: видно, что пропустил, и можно ткнуть в слово
	function renderPauseView(): void {
		const starts = stream.paraStarts;
		let lo = 0;
		let hi = starts.length - 1;
		let p = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (starts[mid] <= player.index) {
				p = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		let from = starts[p];
		let to = p + 1 < starts.length ? starts[p + 1] : player.words.length;
		if (to - from > 90) {
			from = Math.max(from, player.index - 45);
			to = Math.min(to, from + 90);
		}
		const frag = document.createDocumentFragment();
		if (from > starts[p]) frag.append("… ");
		for (let i = from; i < to; i++) {
			const sp = h("span", { "data-i": i }, player.words[i].text);
			if (i === player.index) sp.className = "here";
			frag.append(sp, " ");
		}
		if (p + 1 < starts.length && to < starts[p + 1]) frag.append("…");
		pauseView.replaceChildren(h("p", {}, frag));
	}

	pauseView.addEventListener("click", (e) => {
		const t = (e.target as HTMLElement).closest("span[data-i]");
		if (!t) return;
		player.seek(Number(t.getAttribute("data-i")));
		renderPauseView();
	});

	function applyLook(): void {
		view.classList.toggle("with-context", s.context);
		view.classList.toggle("with-guides", s.guides);
		view.style.setProperty("--word-size", `${s.wordSize}px`);
		geometry();
	}

	// ---- экран не гаснет во время чтения
	async function lockScreen(): Promise<void> {
		try {
			const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<Sentinel> } }).wakeLock;
			if (!wl || wakeLock) return;
			const lock = await wl.request("screen");
			if (disposed || !player.playing) {
				lock.release().catch(() => {});
				return;
			}
			wakeLock = lock;
			// Снята системой (свернули, экономия заряда) — забываем, чтобы запросить снова
			lock.addEventListener("release", () => {
				if (wakeLock === lock) wakeLock = null;
			});
		} catch {
			wakeLock = null;
		}
	}

	function unlockScreen(): void {
		wakeLock?.release().catch(() => {});
		wakeLock = null;
	}

	// ---- управление
	const togglePlay = () => {
		if (s.sound) unlockAudio();
		player.toggle();
	};
	playBtn.addEventListener("click", togglePlay);
	stage.addEventListener("click", togglePlay);

	const onKey = (e: KeyboardEvent) => {
		if (document.querySelector(".sheet-backdrop")) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === " " || e.key === "k") {
			e.preventDefault();
			togglePlay();
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			player.backSentence();
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			player.forwardSentence();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			changeWpm(WPM_STEP);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			changeWpm(-WPM_STEP);
		}
	};
	const onHide = () => {
		if (document.visibilityState === "hidden") player.pause();
		else if (player.playing) lockScreen();
	};
	const relayout = () => {
		if (disposed) return;
		applyLook();
		player.show();
	};
	document.addEventListener("keydown", onKey);
	document.addEventListener("visibilitychange", onHide);
	// Раскладка известна только после вставки в страницу: первый показ делает наблюдатель за размером сцены
	let observer: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(relayout);
		observer.observe(stage);
	} else window.addEventListener("resize", relayout);

	applyLook();
	await document.fonts?.ready;
	if (!disposed) {
		player.show();
		onState();
	}

	const self: ModeView = {
		root: view,
		word: () => player.index,
		seek: (w) => player.seek(w),
		pause: () => player.pause(),
		settingsRows() {
			const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
				s[k] = v;
				host.saveSettings();
				self.applySettings();
			};
			return [
				speedRow(s, (v) => set("wpm", v)),
				range("Размер слова", s.wordSize, 24, 160, 2, (v) => `${v} px`, (v) => set("wordSize", v)),
				segmented<FontKind>("Шрифт", s.font, FONT_OPTIONS, (v) => set("font", v)),
				segmented<PauseLevel>("Паузы на знаках", s.pauses, [[0, "Нет"], [1, "Мягкие"], [2, "Обычные"], [3, "Длинные"]], (v) => set("pauses", v)),
				toggle("Тиканье", "Тихий щелчок на каждое слово держит ритм", s.sound, (v) => set("sound", v)),
				toggle("Соседние слова", "Бледно показывать предыдущее и следующее", s.context, (v) => set("context", v)),
				toggle("Направляющие", "Линии с засечкой над и под словом", s.guides, (v) => set("guides", v)),
				toggle("Плавный старт", "Первые слова после паузы идут медленнее", s.ramp, (v) => set("ramp", v)),
				toggle("Умная скорость", "Короткие слова быстрее, длинные медленнее", s.smart, (v) => set("smart", v)),
			];
		},
		applySettings() {
			if (s.pauses !== level) {
				level = s.pauses;
				stream = level === SHARED_LEVEL ? host.stream : buildWords(host.book.paragraphs, level);
				player.stream = stream;
			}
			player.opts.smart = s.smart;
			player.opts.ramp = s.ramp;
			player.setWpm(s.wpm);
			applyLook();
			player.show();
		},
		destroy() {
			disposed = true;
			player.pause();
			player.destroy();
			unlockScreen();
			observer?.disconnect();
			window.removeEventListener("resize", relayout);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("visibilitychange", onHide);
		},
	};
	return self;
};
