// Цитата для закладки: выделенный текст в одну строку
/** Выделение → цитата: пробелы и переводы строк — один пробел, края обрезаны, длиннее max — обрезка по границе слова и «…». */
export function cleanQuote(text: string, max = 1000): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max);
	// обрезаем по последнему пробелу; слово без пробелов режется по max
	const sp = cut.lastIndexOf(" ");
	const base = t[max] === " " ? cut : sp > 0 ? cut.slice(0, sp) : cut;
	return `${base.trimEnd()}…`;
}
