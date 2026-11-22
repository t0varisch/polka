import { describe, expect, it } from "vitest";
import { decodeBase64, imageSize, makeImage, sniffImage } from "./images";
import { utf8 } from "./test-fixtures";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const bytes = (...a: number[]) => new Uint8Array(a);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

function png(w: number, h: number): Uint8Array {
	return bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0);
}
function gif(w: number, h: number): Uint8Array {
	return bytes(...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0);
}
function jpeg(w: number, h: number): Uint8Array {
	// SOI, APP0 (JFIF), DQT, SOF0
	return bytes(
		0xff, 0xd8,
		0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
		0xff, 0xdb, 0x00, 0x05, 1, 2, 3,
		0xff, 0xc0, 0x00, 0x11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
	);
}
function webpVp8x(w: number, h: number): Uint8Array {
	return bytes(...ascii("RIFF"), ...le32(22), ...ascii("WEBP"), ...ascii("VP8X"), ...le32(10), 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1));
}
function bmp(w: number, h: number): Uint8Array {
	return bytes(0x42, 0x4d, ...le32(54), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(w), ...le32(h), 1, 0, 24, 0);
}

describe("sniffImage", () => {
	it("узнаёт каждый тип по первым байтам", () => {
		expect(sniffImage(jpeg(10, 10))).toBe("image/jpeg");
		expect(sniffImage(png(1, 1))).toBe("image/png");
		expect(sniffImage(gif(1, 1))).toBe("image/gif");
		expect(sniffImage(bytes(...ascii("GIF87a"), 1, 0, 1, 0))).toBe("image/gif");
		expect(sniffImage(webpVp8x(5, 5))).toBe("image/webp");
		expect(sniffImage(bmp(2, 2))).toBe("image/bmp");
		expect(sniffImage(utf8(`<svg xmlns="http://www.w3.org/2000/svg"/>`))).toBe("image/svg+xml");
		expect(sniffImage(utf8(`﻿ \n<?xml version="1.0"?><svg width="1"/>`))).toBe("image/svg+xml");
	});

	it("мусор и не-картинки — null", () => {
		expect(sniffImage(bytes())).toBeNull();
		expect(sniffImage(bytes(1, 2, 3, 4))).toBeNull();
		expect(sniffImage(utf8("просто текст"))).toBeNull();
		expect(sniffImage(utf8("<html><body>нет такого</body></html>"))).toBeNull();
		expect(sniffImage(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBeNull();
	});
});

describe("imageSize", () => {
	it("PNG, GIF, JPEG, WebP, BMP", () => {
		expect(imageSize(png(3, 2), "image/png")).toEqual({ w: 3, h: 2 });
		expect(imageSize(gif(5, 4), "image/gif")).toEqual({ w: 5, h: 4 });
		expect(imageSize(jpeg(640, 480), "image/jpeg")).toEqual({ w: 640, h: 480 });
		expect(imageSize(webpVp8x(300, 200), "image/webp")).toEqual({ w: 300, h: 200 });
		expect(imageSize(bmp(7, 6), "image/bmp")).toEqual({ w: 7, h: 6 });
	});

	it("BMP с отрицательной высотой — высота положительная", () => {
		expect(imageSize(bmp(7, -6 >>> 0), "image/bmp")).toEqual({ w: 7, h: 6 });
	});

	it("SVG: width/height, иначе viewBox", () => {
		expect(imageSize(utf8(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>`), "image/svg+xml")).toEqual({ w: 120, h: 80 });
		expect(imageSize(utf8(`<svg viewBox="0 0 40 30"/>`), "image/svg+xml")).toEqual({ w: 40, h: 30 });
		expect(imageSize(utf8(`<svg width="100%" height="50%" viewBox="0 0 40 30"/>`), "image/svg+xml")).toEqual({ w: 40, h: 30 });
	});

	it("мусор и обрезанные заголовки — null", () => {
		expect(imageSize(bytes(1, 2, 3), "image/png")).toBeNull();
		expect(imageSize(bytes(0xff, 0xd8, 0xff), "image/jpeg")).toBeNull();
		expect(imageSize(utf8("<svg/>"), "image/svg+xml")).toBeNull();
		expect(imageSize(bytes(1, 2, 3), "image/tiff")).toBeNull();
	});
});

describe("decodeBase64", () => {
	it("выкидывает пробелы и переводы строк", () => {
		const spaced = PNG_1X1.replace(/(.{20})/g, "$1\r\n  ");
		const out = decodeBase64(spaced);
		expect(out).not.toBeNull();
		expect(sniffImage(out!)).toBe("image/png");
		expect(imageSize(out!, "image/png")).toEqual({ w: 1, h: 1 });
	});

	it("невалидная строка — null", () => {
		expect(decodeBase64("это не base64!!!")).toBeNull();
		expect(decodeBase64("")).toBeNull();
		expect(decodeBase64("A")).toBeNull();
		expect(decodeBase64("AB=C")).toBeNull();
	});
});

describe("makeImage", () => {
	it("тип по байтам важнее объявленного, размер из заголовка", () => {
		expect(makeImage(3, png(3, 2), "image/jpeg")).toMatchObject({ at: 3, mime: "image/png", w: 3, h: 2 });
	});

	it("не узнали байты — берёт объявленный image/…, размер 0×0", () => {
		expect(makeImage(0, bytes(1, 2, 3, 4), "image/jpeg")).toMatchObject({ mime: "image/jpeg", w: 0, h: 0 });
	});

	it("нет данных или типа — null", () => {
		expect(makeImage(0, null, "image/png")).toBeNull();
		expect(makeImage(0, bytes(), "image/png")).toBeNull();
		expect(makeImage(0, bytes(1, 2, 3, 4), "")).toBeNull();
		expect(makeImage(0, bytes(1, 2, 3, 4), "text/html")).toBeNull();
	});
});
