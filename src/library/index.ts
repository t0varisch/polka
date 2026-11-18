import { BrowserLibrary } from "./browser";
import { db } from "./db";
import { FolderLibrary } from "./folder";
import type { Library } from "./types";

export type FolderState = "unsupported" | "none" | "granted" | "needs-permission";

const HANDLE_KEY = "folder";

function isSupported(): boolean {
	return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function storedHandle(): Promise<FileSystemDirectoryHandle | null> {
	try {
		return ((await (await db()).get("handles", HANDLE_KEY)) as FileSystemDirectoryHandle | undefined) ?? null;
	} catch {
		return null;
	}
}

/** Состояние папки по сохранённому дескриптору. Без queryPermission (папка в песочнице) доступ считаем выданным. */
export async function folderStateOf(handle: FileSystemDirectoryHandle | null, supported: boolean): Promise<FolderState> {
	if (!supported) return "unsupported";
	if (!handle) return "none";
	if (typeof handle.queryPermission !== "function") return "granted";
	try {
		return (await handle.queryPermission({ mode: "readwrite" })) === "granted" ? "granted" : "needs-permission";
	} catch {
		// дескриптор протух или браузер отказал: просим разрешение заново, приложение должно открыться
		return "needs-permission";
	}
}

/** Выбор библиотеки при запуске: папка, если она выбрана и доступна, иначе браузер. */
export async function currentLibrary(): Promise<{ lib: Library; folder: FolderState; folderName?: string }> {
	// тестовый вход: папка в песочнице браузера, без выбора и без записи в базу
	if (typeof location !== "undefined" && location.search.includes("testfolder")) {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle("testbooks", { create: true });
		return { lib: new FolderLibrary(dir), folder: "granted", folderName: dir.name };
	}
	const supported = isSupported();
	const handle = supported ? await storedHandle() : null;
	const folder = await folderStateOf(handle, supported);
	if (folder === "granted" && handle) return { lib: new FolderLibrary(handle), folder, folderName: handle.name };
	return { lib: new BrowserLibrary(), folder, folderName: handle?.name };
}

/** Выбор папки пользователем; false — отменил. Вызывать из нажатия. */
export async function pickFolder(): Promise<boolean> {
	if (!isSupported()) return false;
	let handle: FileSystemDirectoryHandle;
	try {
		handle = await window.showDirectoryPicker!({ mode: "readwrite", id: "polka" });
	} catch (e) {
		if ((e as { name?: string }).name === "AbortError") return false;
		throw e;
	}
	await (await db()).put("handles", handle, HANDLE_KEY);
	return true;
}

/** Повторная выдача доступа к уже выбранной папке. Только из нажатия. */
export async function regrantFolder(): Promise<boolean> {
	const handle = await storedHandle();
	if (!handle || typeof handle.requestPermission !== "function") return false;
	return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function forgetFolder(): Promise<void> {
	await (await db()).delete("handles", HANDLE_KEY);
}
