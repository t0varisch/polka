import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { BookRecord, TocEntry } from "../types";

export interface Schema extends DBSchema {
	books: { key: string; value: BookRecord };
	texts: { key: string; value: { id: string; paragraphs: string[]; toc: TocEntry[] } };
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

export async function getText(id: string): Promise<{ paragraphs: string[]; toc: TocEntry[] } | null> {
	const t = await (await db()).get("texts", id);
	return t ? { paragraphs: t.paragraphs, toc: t.toc } : null;
}

export async function putText(id: string, paragraphs: string[], toc: TocEntry[]): Promise<void> {
	await (await db()).put("texts", { id, paragraphs, toc });
}

/** Просим браузер не чистить книги при нехватке места (важно для iPhone). */
export function askPersist(): void {
	try {
		navigator.storage?.persist?.().catch(() => {});
	} catch {
		// не поддерживается
	}
}
