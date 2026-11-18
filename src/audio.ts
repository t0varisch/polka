// Тик на каждое слово. Звук как в Speeedy (MIT, © 2026 Speeedy): короткий синус,
// ниже тоном на запятой и на конце предложения.

type Ctx = AudioContext;
let ctx: Ctx | null = null;

/** Тип звуковой сессии Safari 16.4+: «playback» звучит и при беззвучном режиме iPhone. */
function setSessionType(type: "playback" | "auto"): void {
	try {
		const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
		if (session && session.type !== type) session.type = type;
	} catch {
		/* старые браузеры */
	}
}

/** Вызывать только из обработчика нажатия: iOS запускает звук лишь после жеста. */
export function unlockAudio(): void {
	setSessionType("playback");
	try {
		if (ctx && ctx.state === "closed") ctx = null;
		if (!ctx) {
			const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!C) return;
			ctx = new C();
		}
		if (ctx.state !== "running") ctx.resume().catch(() => {});
	} catch {
		ctx = null;
	}
}

export function tick(kind: "word" | "comma" | "end"): void {
	// Контекст создаётся только по нажатию (unlockAudio), здесь лишь используется
	const c = ctx;
	if (!c || c.state !== "running") return;
	try {
		const now = c.currentTime;
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.connect(gain);
		gain.connect(c.destination);
		osc.type = "sine";
		osc.frequency.setValueAtTime(kind === "end" ? 660 : kind === "comma" ? 780 : 880, now);
		const dur = kind === "end" ? 0.015 : kind === "comma" ? 0.01 : 0.008;
		gain.gain.setValueAtTime(kind === "end" ? 0.04 : kind === "comma" ? 0.03 : 0.035, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
		osc.start(now);
		osc.stop(now + dur);
	} catch {
		/* звук не критичен */
	}
}

// Звук клавиш для печати (из «Печатки»): тихий щелчок на верное нажатие, глухой низкий — на ошибку
function beep(freq: number, dur: number, volume: number, type: OscillatorType): void {
	const c = ctx;
	if (!c || c.state !== "running") return;
	try {
		const now = c.currentTime;
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.connect(gain);
		gain.connect(c.destination);
		osc.type = type;
		osc.frequency.setValueAtTime(freq, now);
		gain.gain.setValueAtTime(volume, now);
		gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
		osc.start(now);
		osc.stop(now + dur);
	} catch {
		/* звук не критичен */
	}
}

export function keyClick(): void {
	beep(1500, 0.012, 0.03, "triangle");
}

export function errorSound(): void {
	beep(140, 0.09, 0.07, "square");
}
