// Режим «Страницы» — одна лента: раскладка и управление в ribbon.ts
import { ribbonMode } from "./ribbon";
import type { ModeFactory } from "./types";

/** «Страницы» на любом устройстве открывают ленту: палец и колесо двигают строки, тап, клавиши и свайп листают на экран. */
export const pagesMode: ModeFactory = ribbonMode;
