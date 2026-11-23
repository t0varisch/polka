// Лента: чистые функции экрана. Координаты — в содержимом ленты, строки (и рисунки) заданы возрастающими верхом и низом.

/** Допуск на дробные размеры строк, px. */
const EPS = 0.5;

/**
 * Верх следующего экрана: первая строка, чей низ ниже нижнего края экрана (top + height) — она не влезла целиком
 * или не видна. Такой строки нет (конец текста) — top.
 * Элемент выше экрана, начавшийся не ниже top, дал бы нулевой шаг: берётся верх следующего элемента, а если его нет — top + height.
 */
export function nextScreenTop(lineTops: number[], lineBottoms: number[], top: number, height: number): number {
	const edge = top + height + EPS;
	let lo = 0;
	let hi = lineBottoms.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineBottoms[mid] > edge) hi = mid;
		else lo = mid + 1;
	}
	if (lo >= lineBottoms.length) return top;
	if (lineTops[lo] > top + EPS) return lineTops[lo];
	// элемент выше экрана: пропускаем его остаток
	for (let j = lo + 1; j < lineTops.length; j++) if (lineTops[j] > top + EPS) return lineTops[j];
	return top + height;
}

/**
 * Верх предыдущего экрана: наименьший верх строки, не меньше top - height. Меньше 0 не бывает.
 * В окне нет строк (элемент выше экрана) — сдвиг ровно на высоту экрана.
 */
export function prevScreenTop(lineTops: number[], top: number, height: number): number {
	const lo = top - height;
	if (lo <= 0) return 0;
	let a = 0;
	let b = lineTops.length;
	while (a < b) {
		const mid = (a + b) >> 1;
		if (lineTops[mid] >= lo - EPS) b = mid;
		else a = mid + 1;
	}
	if (a >= lineTops.length || lineTops[a] >= top - EPS) return lo;
	return lineTops[a];
}

/** Верх следующей строки: наименьший верх больше top + 1. Нет — top. Для колеса мыши: одна засечка — одна строка. */
export function nextLineTop(lineTops: number[], top: number): number {
	const edge = top + 1;
	let lo = 0;
	let hi = lineTops.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineTops[mid] > edge) hi = mid;
		else lo = mid + 1;
	}
	return lo < lineTops.length ? lineTops[lo] : top;
}

/** Верх предыдущей строки: наибольший верх меньше top - 1. Нет — 0. */
export function prevLineTop(lineTops: number[], top: number): number {
	const edge = top - 1;
	let lo = 0;
	let hi = lineTops.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineTops[mid] < edge) lo = mid + 1;
		else hi = mid;
	}
	return lo > 0 ? lineTops[lo - 1] : 0;
}

/**
 * Сетка экранов куска: верхи от 0, каждый следующий — nextScreenTop от прежнего, пока тот сдвигается.
 * Строки и рисунки — только этого куска, в его координатах. Длина сетки — число страниц куска.
 */
export function screenGrid(lineTops: number[], lineBottoms: number[], height: number): number[] {
	const grid = [0];
	for (;;) {
		const cur = grid[grid.length - 1];
		const next = nextScreenTop(lineTops, lineBottoms, cur, height);
		if (next <= cur + EPS) return grid;
		grid.push(next);
	}
}

/** Номер ячейки сетки (от 0), в которую попало смещение от верха куска: сколько верхов не больше смещения, минус 1. Выше куска — 0. */
export function screenIndex(grid: number[], offset: number): number {
	let lo = 0;
	let hi = grid.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (grid[mid] <= offset + EPS) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(0, lo - 1);
}
