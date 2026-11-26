// Экран не гаснет, пока человек что-то делает: каждое действие продлевает замок, простой его отпускает
type Sentinel = { release(): Promise<void>; addEventListener(t: "release", f: () => void): void };
export type WakeLockApi = { request(type: "screen"): Promise<Sentinel> };

/** Сколько можно не нажимать клавиш, прежде чем экрану разрешат гаснуть. */
export const TYPING_IDLE_MS = 5 * 60_000;

export function idleWakeLock(idleMs: number, api?: WakeLockApi | null): { poke(): void; release(): void } {
	const wl = api === undefined ? ((navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock ?? null) : api;
	let lock: Sentinel | null = null;
	let requesting = false;
	// Поколение: release() во время запроса делает пришедший замок ненужным
	let gen = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function release(): void {
		gen++;
		if (timer) clearTimeout(timer);
		timer = null;
		const l = lock;
		lock = null;
		l?.release().catch(() => {});
	}

	async function acquire(): Promise<void> {
		if (!wl || lock || requesting) return;
		requesting = true;
		const mine = gen;
		try {
			const l = await wl.request("screen");
			if (mine !== gen) {
				l.release().catch(() => {});
				return;
			}
			lock = l;
			// Снята системой (свернули, экономия заряда) — забываем, чтобы запросить снова
			l.addEventListener("release", () => {
				if (lock === l) lock = null;
			});
		} catch {
			lock = null;
		} finally {
			requesting = false;
		}
	}

	return {
		poke() {
			if (!wl) return;
			void acquire();
			if (timer) clearTimeout(timer);
			timer = setTimeout(release, idleMs);
		},
		release,
	};
}
