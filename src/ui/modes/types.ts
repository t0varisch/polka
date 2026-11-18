// Договор между оболочкой книги и режимами чтения. Общая единица места — индекс слова в stream.words
import type { WordStream } from "../../core/words";
import type { Settings } from "../../settings";
import type { BookRecord, OpenedBook } from "../../types";

export interface ModeHost {
	book: OpenedBook;
	/** buildWords(paragraphs) — один на книгу. */
	stream: WordStream;
	settings: Settings;
	saveSettings(): void;
	/** Режим сообщает текущее слово; оболочка сохраняет не чаще раза в 3 с. */
	report(word: number): void;
	/** Сохранить сейчас. */
	flush(): void;
	addBookmark(): void;
	openNav(): void;
	goLibrary(): void;
	updateTyping(t: BookRecord["typing"]): void;
}

export interface ModeView {
	/** Всё под верхней панелью. */
	readonly root: HTMLElement;
	word(): number;
	/** Переход из оглавления, закладки, ползунка. */
	seek(word: number): void;
	/** Перед листом настроек или навигации. */
	pause(): void;
	/** Строки настроек своего режима. */
	settingsRows(): HTMLElement[];
	applySettings(): void;
	destroy(): void;
}

export type ModeFactory = (host: ModeHost, startWord: number) => Promise<ModeView>;
