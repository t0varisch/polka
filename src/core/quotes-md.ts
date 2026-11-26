// Цитаты книги одним текстом в Markdown
export interface QuoteItem {
	quote: string;
	chapter: string | null;
	/** Номер страницы — только когда книга открыта в «Страницах» */
	page: number | null;
	pct: number;
}

/** Подпись под цитатой: «— Глава, стр. 12», «— Глава, 34%», «— стр. 12» или «— 34%» */
function signature(q: QuoteItem): string {
	const where = q.page != null ? `стр. ${q.page}` : `${Math.round(q.pct)}%`;
	return `— ${q.chapter ? `${q.chapter}, ` : ""}${where}`;
}

/** Пустая строка между цитатой и подписью обязательна: иначе подпись прилипает к цитате */
export function quotesMarkdown(title: string, author: string, items: QuoteItem[]): string {
	const blocks = [`# ${title}`];
	if (author.trim()) blocks.push(author.trim());
	for (const q of items) {
		blocks.push(q.quote.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n"));
		blocks.push(signature(q));
	}
	return `${blocks.join("\n\n")}\n`;
}
