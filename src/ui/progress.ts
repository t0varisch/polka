import type { ParseProgress } from "../library/types";

/** Если за это время разбор не сдвинулся ни на шаг — считаем, что завис. */
export const STALL_MS = 60000;

/**
 * Запускает долгую работу с разбором файла: пишет строку «Открываю «…» …%» в `busy`
 * и бросает ошибку, если за STALL_MS прогресс не двигался.
 */
export async function withProgress<T>(busy: HTMLElement, label: string, run: (p: ParseProgress) => Promise<T>): Promise<T> {
	let pct = 0;
	let stage = "";
	let moved = Date.now();
	const show = () => {
		moved = Date.now();
		busy.textContent = `Открываю «${label}»… ${pct}%${stage ? ` · ${stage}` : ""}`;
	};
	show();
	let watch: ReturnType<typeof setInterval> | undefined;
	const stalled = new Promise<never>((_, reject) => {
		watch = setInterval(() => {
			if (Date.now() - moved > STALL_MS) reject(new Error(`файл обрабатывается слишком долго (шаг: ${stage || `${pct}%`})`));
		}, 2000);
	});
	try {
		return await Promise.race([
			run({
				onProgress: (x) => ((pct = Math.round(x * 100)), show()),
				onStage: (s) => ((stage = s), show()),
			}),
			stalled,
		]);
	} finally {
		clearInterval(watch);
	}
}
