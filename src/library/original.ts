/** Тип файла книги: заданный браузером, а если его нет или он общий — по расширению */
export function bookMime(name: string, type: string): string {
	if (type && type !== "application/octet-stream") return type;
	const n = name.toLowerCase();
	if (n.endsWith(".fb2.zip") || n.endsWith(".zip")) return "application/zip";
	if (n.endsWith(".fb2")) return "application/x-fictionbook+xml";
	if (n.endsWith(".epub")) return "application/epub+zip";
	if (n.endsWith(".pdf")) return "application/pdf";
	if (n.endsWith(".txt")) return "text/plain";
	return "application/octet-stream";
}
