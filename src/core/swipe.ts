/** Рывок: быстрее этого (px/мс) палец листает и при коротком сдвиге. */
const FLING_SPEED = 0.5;
/** Рывок короче этого (px) — дрожание пальца, а не листание. */
const FLING_MIN_PX = 8;

/**
 * Что делать, когда палец отпущен: 1 — листать вперёд (сдвиг влево), -1 — назад (вправо), 0 — вернуть страницу.
 * dx — сдвиг пальца, ms — время касания, width — ширина страницы, swipePx — порог сдвига.
 */
export function swipeDecision(dx: number, ms: number, width: number, swipePx: number): -1 | 0 | 1 {
	const dist = Math.abs(dx);
	const dir = dx < 0 ? 1 : -1;
	// на узкой странице порог не больше четверти ширины
	const need = Math.min(swipePx, Math.max(FLING_MIN_PX, width / 4));
	if (dist >= need) return dir;
	if (dist > FLING_MIN_PX && dist / Math.max(1, ms) > FLING_SPEED) return dir;
	return 0;
}
