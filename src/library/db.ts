import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { BookImage, BookRecord, TocEntry } from "../types";
import { type CachedText, TEXT_VERSION } from "./text";

export interface Schema extends DBSchema {
	books: { key: string; value: BookRecord };
	/** images и v — необязательные: записи, сделанные до рисунков, их не имеют. */
	texts: { key: string; value: { id: string; paragraphs: string[]; toc: TocEntry[]; images?: BookImage[]; v?: number } };
	/** Дескриптор выбранной папки под ключом "folder". */
	handles: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
	if (!dbp) {
		dbp = openDB<Schema>("polka", 1, {
			upgrade(d) {
				d.createObjectStore("books", { keyPath: "id" });
				d.createObjectStore("texts", { keyPath: "id" });
				d.createObjectStore("handles");
			},
		});
	}
	return dbp;
}

/** Нет images в записи — рисунков нет, нет v — это версия 1 (до рисунков). */
export async function getText(id: string): Promise<CachedText | null> {
	const t = await (await db()).get("texts", id);
	return t ? { paragraphs: t.paragraphs, toc: t.toc, images: t.images ?? [], v: t.v ?? 1 } : null;
}

export async function putText(id: string, paragraphs: string[], toc: TocEntry[], images: BookImage[]): Promise<void> {
	await (await db()).put("texts", { id, paragraphs, toc, images, v: TEXT_VERSION });
}

/** Просим браузер не чистить книги при нехватке места (важно для iPhone). */
export function askPersist(): void {
	try {
		navigator.storage?.persist?.().catch(() => {});
	} catch {
		// не поддерживается
	}
}
