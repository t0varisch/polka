// Рисунки из книг: тип по первым байтам, размер из заголовка, base64 из FB2.
import type { BookImage } from "../types";

const startsWith = (d: Uint8Array, sig: number[], at = 0) => d.length >= at + sig.length && sig.every((b, i) => d[at + i] === b);
const ascii = (d: Uint8Array, from: number, to: number) => String.fromCharCode(...d.subarray(from, Math.min(to, d.length)));
const be16 = (d: Uint8Array, i: number) => (d[i] << 8) | d[i + 1];
const le16 = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const le24 = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
const le32 = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
const be32 = (d: Uint8Array, i: number) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;

/** Начало SVG-файла как текст: без BOM и пробелов, пустая строка — если это не текст с «<». */
function svgHead(d: Uint8Array): string {
	let s = new TextDecoder("utf-8").decode(d.subarray(0, 1024)).replace(/^﻿/, "");
	s = s.replace(/^\s+/, "");
	return s.startsWith("<") ? s : "";
}

/** Тип картинки по первым байтам; null — не картинка. */
export function sniffImage(data: Uint8Array): string | null {
	if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	const g = ascii(data, 0, 6);
	if (g === "GIF87a" || g === "GIF89a") return "image/gif";
	if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "image/webp";
	if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
	if (svgHead(data).includes("<svg")) return "image/svg+xml";
	return null;
}

function jpegSize(d: Uint8Array): { w: number; h: number } | null {
	let i = 2;
	while (i + 4 <= d.length) {
		if (d[i] !== 0xff) {
			i++;
			continue;
		}
		const m = d[i + 1];
		if (m === 0xff) {
			i++;
			continue;
		}
		// маркеры без длины
		if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = be16(d, i + 2);
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			if (i + 9 > d.length) return null;
			return { h: be16(d, i + 5), w: be16(d, i + 7) };
		}
		if (len < 2) return null;
		i += 2 + len;
	}
	return null;
}

function webpSize(d: Uint8Array): { w: number; h: number } | null {
	const kind = ascii(d, 12, 16);
	if (kind === "VP8 " && d.length >= 30) return { w: le16(d, 26) & 0x3fff, h: le16(d, 28) & 0x3fff };
	if (kind === "VP8L" && d.length >= 25) {
		const b = le32(d, 21);
		return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
	}
	if (kind === "VP8X" && d.length >= 30) return { w: le24(d, 24) + 1, h: le24(d, 27) + 1 };
	return null;
}

function svgSize(d: Uint8Array): { w: number; h: number } | null {
	const text = new TextDecoder("utf-8").decode(d.subarray(0, 4096));
	const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
	if (!tag) return null;
	const attr = (name: string) => new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
	const num = (name: string): number | null => {
		const m = attr(name);
		const v = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(m?.[1] ?? m?.[2] ?? "");
		return v ? Number(v[1]) : null;
	};
	const w = num("width");
	const h = num("height");
	if (w && h) return { w: Math.round(w), h: Math.round(h) };
	const vb = attr("viewBox");
	const parts = (vb?.[1] ?? vb?.[2] ?? "").trim().split(/[\s,]+/).map(Number);
	if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) return { w: Math.round(parts[2]), h: Math.round(parts[3]) };
	return null;
}

/** Размер в пикселях из заголовка файла; null — не узнали. */
export function imageSize(data: Uint8Array, mime: string): { w: number; h: number } | null {
	let r: { w: number; h: number } | null = null;
	try {
		if (mime === "image/png") r = data.length >= 24 ? { w: be32(data, 16), h: be32(data, 20) } : null;
		else if (mime === "image/gif") r = data.length >= 10 ? { w: le16(data, 6), h: le16(data, 8) } : null;
		else if (mime === "image/jpeg") r = jpegSize(data);
		else if (mime === "image/webp") r = webpSize(data);
		else if (mime === "image/bmp") r = data.length >= 26 ? { w: le32(data, 18), h: Math.abs(le32(data, 22) | 0) } : null;
		else if (mime === "image/svg+xml") r = svgSize(data);
	} catch {
		return null;
	}
	return r && r.w > 0 && r.h > 0 ? r : null;
}

/** Base64 → байты. Пробелы и переводы строк выкидываются; невалидная строка — null. */
export function decodeBase64(s: string): Uint8Array | null {
	const clean = s.replace(/\s+/g, "");
	if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) return null;
	try {
		const bin = atob(clean);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/** Собирает рисунок. Тип — по байтам, иначе объявленный (только image/…); нет данных или типа — null. */
export function makeImage(at: number, data: Uint8Array | null, declaredMime: string): BookImage | null {
	if (!data || !data.length) return null;
	const declared = declaredMime.trim().toLowerCase();
	const mime = sniffImage(data) ?? (declared.startsWith("image/") ? declared : null);
	if (!mime) return null;
	const size = imageSize(data, mime) ?? { w: 0, h: 0 };
	return { at, mime, data, w: size.w, h: size.h };
}
