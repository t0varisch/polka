// Отдать текст человеку: на телефоне — «Поделиться», на ПК — в буфер обмена

/** Запасной путь, когда нет navigator.clipboard или он отказал */
function copyViaTextarea(text: string): boolean {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
	document.body.append(ta);
	ta.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		ta.remove();
	}
}

async function copy(text: string): Promise<"copied" | "failed"> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return "copied";
		}
	} catch {
		// отказ в разрешении — пробуем запасной путь
	}
	return copyViaTextarea(text) ? "copied" : "failed";
}

/**
 * Вызывать прямо из обработчика касания без await до него: iPhone Safari требует жест для share.
 * Касание и есть navigator.share → системное «Поделиться»; иначе буфер обмена.
 */
export async function sendText(text: string, title: string): Promise<"shared" | "copied" | "cancelled" | "failed"> {
	const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	if (touch && typeof navigator.share === "function") {
		try {
			await navigator.share({ title, text });
			return "shared";
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
			// другая ошибка «Поделиться» — копируем
		}
	}
	return copy(text);
}
