import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { BookImage, BookRecord, TocEntry } from "../types";
import { bookMime } from "./original";
import { type CachedText, TEXT_VERSION } from "./text";

export interface Schema extends DBSchema {
	books: { key: string; value: BookRecord };
	/** images и v — необязательные: записи, сделанные до рисунков, их не имеют. */
	texts: { key: string; value: { id: string; paragraphs: string[]; toc: TocEntry[]; images?: BookImage[]; v?: number } };
	/** Дескриптор выбранной папки под ключом "folder". */
	handles: { key: string; value: unknown };
	/** Исходный файл книги, чтобы им можно было поделиться */
	files: { key: string; value: { id: string; name: string; type: string; data: ArrayBuffer } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

/** Крючок для интерфейса: библиотека сама тосты не показывает */
export const dbEvents: { onBlocked?: () => void } = {};

/** Обновление базы по шагам: у тех, кто уже на версии 1, остаются книги, тексты и папка */
export function upgradeDb(d: { createObjectStore(name: string, opts?: IDBObjectStoreParameters): unknown }, oldVersion: number): void {
	if (oldVersion < 1) {
		d.createObjectStore("books", { keyPath: "id" });
		d.createObjectStore("texts", { keyPath: "id" });
		d.createObjectStore("handles");
	}
	if (oldVersion < 2) d.createObjectStore("files", { keyPath: "id" });
}

export function db(): Promise<IDBPDatabase<Schema>> {
	if (!dbp) {
		dbp = openDB<Schema>("polka", 2, {
			upgrade(d, oldVersion) {
				upgradeDb(d, oldVersion);
			},
			// старое окно держит соединение версии 1: просим закрыть его
			blocked() {
				dbEvents.onBlocked?.();
			},
			// новое окно хочет обновить базу: отпускаем соединение, следующий db() откроет заново
			blocking() {
				const old = dbp;
				dbp = null;
				old?.then((c) => c.close()).catch(() => {});
			},
		});
	}
	return dbp;
}

export async function getFile(id: string): Promise<File | null> {
	const r = await (await db()).get("files", id);
	return r ? new File([r.data], r.name, { type: r.type }) : null;
}

export async function putFile(id: string, file: File): Promise<void> {
	const data = await file.arrayBuffer();
	await (await db()).put("files", { id, name: file.name, type: bookMime(file.name, file.type), data });
}

export async function hasFile(id: string): Promise<boolean> {
	return (await (await db()).getKey("files", id)) !== undefined;
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
