import { describe, expect, it } from "vitest";
import { parseFb2, parseFb2String } from "./fb2";
import { parseFile } from "./index";
import { PNG_1X1_BASE64, encodeSingleByte, fb2WithCaptions, fb2WithImages, fileFrom, makeZip, utf8 } from "./test-fixtures";

const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".repeat(40);

function fb2Xml(opts: { notesName?: string } = {}): string {
	const notesAttr = opts.notesName === undefined ? ` name="notes"` : opts.notesName ? ` name="${opts.notesName}"` : "";
	return `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<stylesheet type="text/css">p { text-indent: 1em }</stylesheet>
<description>
 <title-info>
  <genre>prose_classic</genre>
  <author><first-name>Лев</first-name><middle-name>Николаевич</middle-name><last-name>Толстой</last-name></author>
  <author><nickname>Аноним</nickname></author>
  <book-title>Тестовая книга</book-title>
  <annotation><p>СЛУЖЕБНАЯ АННОТАЦИЯ</p></annotation>
  <coverpage><image l:href="#cover.jpg"/></coverpage>
  <lang>ru</lang>
 </title-info>
 <document-info><author><nickname>Конвертер</nickname></author><program-used>FictionBook Editor</program-used><id>ABC-123</id></document-info>
 <publish-info><publisher>СЛУЖЕБНОЕ ИЗДАТЕЛЬСТВО</publisher></publish-info>
</description>
<body>
 <title><p>Лев Толстой</p><p>Тестовая книга</p></title>
 <epigraph><p>Эпиграф к книге.</p><text-author>Мудрец</text-author></epigraph>
 <section id="p1">
  <title><p>Часть первая</p><p>Начало</p></title>
  <section id="c1">
   <title><p>Глава 1</p></title>
   <p>Первый абзац <emphasis>с курсивом</emphasis> и <strong>жирным</strong> текстом <a l:href="#n1" type="note">[1]</a>.</p>
   <empty-line/>
   <p>Второй абзац со сноской без типа<a l:href="#n2">2</a> и обычной <a l:href="http://example.com">ссылкой</a>.</p>
   <image l:href="#pic.png"/>
   <poem><title><p>Стих</p></title><stanza><v>Строка один,</v><v>строка два.</v></stanza><text-author>Поэт</text-author></poem>
   <cite><p>Цитата из книги.</p><text-author>Автор цитаты</text-author></cite>
   <subtitle>* * *</subtitle>
   <table><tr><th>Заголовок</th><td>Ячейка</td></tr></table>
  </section>
  <section id="c2">
   <title><p>Глава 2</p><p>Продолжение</p></title>
   <section><title><p>Подглава 2.1</p></title><p>Текст подглавы с неразрывным&#160;пробелом и мяг&#173;ким переносом.</p></section>
  </section>
 </section>
 <section id="p2">
  <title><p>Часть вторая</p></title>
  <p>Последний абзац книги.</p>
 </section>
</body>
<body${notesAttr}>
 <title><p>Примечания</p></title>
 <section id="n1"><title><p>1</p></title><p>ТЕКСТ СНОСКИ ОДИН</p></section>
 <section id="n2"><title><p>2</p></title><p>ТЕКСТ СНОСКИ ДВА</p></section>
</body>
<binary id="cover.jpg" content-type="image/jpeg">${BASE64}</binary>
<binary id="pic.png" content-type="image/png">${BASE64}</binary>
</FictionBook>`;
}

const EXPECTED = [
	"Лев Толстой",
	"Тестовая книга",
	"Эпиграф к книге.",
	"Мудрец",
	"Часть первая",
	"Начало",
	"Глава 1",
	"Первый абзац с курсивом и жирным текстом.",
	"Второй абзац со сноской без типа и обычной ссылкой.",
	"Стих",
	"Строка один,",
	"строка два.",
	"Поэт",
	"Цитата из книги.",
	"Автор цитаты",
	"* * *",
	"Заголовок",
	"Ячейка",
	"Глава 2",
	"Продолжение",
	"Подглава 2.1",
	"Текст подглавы с неразрывным\u00A0пробелом и мягким переносом.",
	"Часть вторая",
	"Последний абзац книги.",
];

const EXPECTED_TOC = [
	{ title: "Часть первая. Начало", level: 0, paragraph: 4 },
	{ title: "Глава 1", level: 1, paragraph: 6 },
	{ title: "Глава 2. Продолжение", level: 1, paragraph: 18 },
	{ title: "Подглава 2.1", level: 2, paragraph: 20 },
	{ title: "Часть вторая", level: 0, paragraph: 22 },
];

function assertClean(paragraphs: string[]): void {
	const all = paragraphs.join("\n");
	for (const bad of ["СЛУЖЕБН", "Конвертер", "FictionBook Editor", "ABC-123", "СНОСКИ", "Примечания", "text-indent", "iVBOR", "[1]"]) {
		expect(all).not.toContain(bad);
	}
	expect(all).not.toMatch(/<\/?[a-zA-Z][^>]{0,40}>/);
	expect(all).not.toMatch(/[A-Za-z0-9+/]{80,}/);
	for (const p of paragraphs) {
		expect(p).toBe(p.trim());
		expect(p).not.toMatch(/[\t\n\r]| {2}|\u00AD/);
		expect(p.length).toBeGreaterThan(0);
	}
}

describe("FB2", () => {
	it("windows-1251: текст, автор, оглавление; без служебного, сносок и base64", () => {
		const bytes = encodeSingleByte(fb2Xml(), "windows-1251");
		const book = parseFb2(bytes, "book.fb2");
		expect(book.title).toBe("Тестовая книга");
		expect(book.author).toBe("Лев Николаевич Толстой, Аноним");
		expect(book.format).toBe("fb2");
		expect(book.paragraphs).toEqual(EXPECTED);
		expect(book.toc).toEqual(EXPECTED_TOC);
		assertClean(book.paragraphs);
		for (const e of book.toc) expect(e.title.startsWith(book.paragraphs[e.paragraph])).toBe(true);
	});

	it("тело сносок без имени тоже пропускается (на его секции ведут ссылки-сноски)", () => {
		const book = parseFb2(encodeSingleByte(fb2Xml({ notesName: "" }), "windows-1251"));
		expect(book.paragraphs).toEqual(EXPECTED);
	});

	it("тело name=comments пропускается", () => {
		const book = parseFb2(encodeSingleByte(fb2Xml({ notesName: "comments" }), "windows-1251"));
		expect(book.paragraphs).toEqual(EXPECTED);
	});

	it("битый XML открывается через запасной разбор, теги не просачиваются", () => {
		const xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><last-name>Иванов</last-name></author><book-title>Битая книга</book-title><annotation><p>АННОТАЦИЯ</p></annotation></title-info></description>
<body><section><title><p>Глава 1</p></title><p>Текст & ещё текст&nbsp;тут</p><p>Незакрытый абзац<p>Следующий</p><style name="x">стиль <emphasis>курсив</emphasis></style><empty-line/><p>После пустой строки</p></section>
<section><title><p>Глава 2</p></title><p>Конец <b>жирный</p><image l:href="#x"/></section></body>
<binary id="x" content-type="image/png">${BASE64}</binary></FictionBook>`;
		const book = parseFb2String(xml);
		expect(book.title).toBe("Битая книга");
		expect(book.author).toBe("Иванов");
		expect(book.toc.map((e) => e.title)).toEqual(["Глава 1", "Глава 2"]);
		const all = book.paragraphs.join("\n");
		expect(all).toContain("Текст & ещё текст\u00A0тут");
		expect(all).toContain("курсив");
		expect(all).toContain("После пустой строки");
		expect(all).toContain("Конец жирный");
		expect(all).not.toContain("АННОТАЦИЯ");
		assertClean(book.paragraphs);
		for (const e of book.toc) expect(book.paragraphs[e.paragraph]).toBe(e.title);
	});

	it("parseFile: .fb2 и .fb2.zip дают одно и то же", async () => {
		const bytes = encodeSingleByte(fb2Xml(), "windows-1251");
		const progress: number[] = [];
		const plain = await parseFile(fileFrom(bytes, "Книга.fb2"), { onProgress: (f) => progress.push(f) });
		const zipped = await parseFile(fileFrom(await makeZip({ "Книга.fb2": bytes }), "Книга.fb2.zip"));
		expect(plain.paragraphs).toEqual(EXPECTED);
		expect(zipped.paragraphs).toEqual(EXPECTED);
		expect(zipped.toc).toEqual(EXPECTED_TOC);
		expect(progress.at(-1)).toBe(1);
	});

	it("FB2 в UTF-8 без объявления кодировки", () => {
		const xml = fb2Xml().replace(` encoding="windows-1251"`, "");
		expect(parseFb2(utf8(xml)).paragraphs).toEqual(EXPECTED);
	});
});

const IMG_PARAGRAPHS = ["Глава 1", "Первый абзац.", "Второй абзац с рисунком внутри.", "Третий абзац.", "Четвёртый абзац."];

/** Тот же текст без рисунков и без binary. */
function withoutImages(xml: string): string {
	return xml.replace(/<image[^>]*>/g, "").replace(/<binary[\s\S]*?<\/binary>/g, "");
}

describe("FB2: рисунки", () => {
	it("обложка первой с at 0, блочный рисунок перед следующим абзацем, inline — после своего; битые пропущены", () => {
		const book = parseFb2String(fb2WithImages());
		expect(book.paragraphs).toEqual(IMG_PARAGRAPHS);
		expect(book.images!.map((i) => i.at)).toEqual([0, 2, 3]);
		for (const img of book.images!) {
			expect(img.mime).toBe("image/png");
			expect([img.w, img.h]).toEqual([1, 1]);
			expect(img.data.length).toBeGreaterThan(20);
		}
		expect(Array.from(book.images![0].data.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
	});

	it("paragraphs и toc те же, что у разбора без тегов image и binary (блочные рисунки)", () => {
		const blockOnly = fb2WithImages().replace(`<image l:href="#inline.png"/>`, "");
		const a = parseFb2String(blockOnly);
		const b = parseFb2String(withoutImages(blockOnly));
		expect(a.images!.length).toBe(2);
		expect(b.images).toBeUndefined();
		expect(a.paragraphs).toEqual(b.paragraphs);
		expect(a.toc).toEqual(b.toc);
		expect(a.toc).toEqual([{ title: "Глава 1", level: 0, paragraph: 0 }]);
	});

	it("обложка, на которую есть ссылка и в тексте, не дублируется", () => {
		const xml = fb2WithImages().replace(`<p>Первый абзац.</p>`, `<p>Первый абзац.</p><image l:href="#cover.png"/>`);
		const images = parseFb2String(xml).images!;
		expect(images.map((i) => i.at)).toEqual([2, 2, 3]);
		expect(images.length).toBe(3);
	});

	it("рисунок после последнего абзаца: at равен числу абзацев", () => {
		const xml = fb2WithImages().replace(`<p>Четвёртый абзац.</p>`, `<p>Четвёртый абзац.</p><image l:href="#pic.png"/>`);
		const book = parseFb2String(xml);
		expect(book.images!.at(-1)!.at).toBe(book.paragraphs.length);
	});

	it("binary с атрибутами в любом порядке и любыми кавычками", () => {
		const xml = `<FictionBook xmlns:xlink="http://www.w3.org/1999/xlink"><body><section><p>Текст.</p><image xlink:href="#a"/><image xlink:href="#b"/></section></body>
<binary content-type='image/png' id='a'>${PNG_1X1_BASE64}</binary>
<fb:binary xmlns:fb="x" content-type="image/png" id="b">${PNG_1X1_BASE64}</fb:binary></FictionBook>`;
		const book = parseFb2String(xml);
		expect(book.images!.map((i) => i.at)).toEqual([1, 1]);
	});

	it("битый FB2 (запасной HTML-разбор) тоже отдаёт рисунки", () => {
		const xml = `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>Битая</book-title><coverpage><image l:href="#x"/></coverpage></title-info></description>
<body><section><title><p>Глава 1</p></title><p>Раз <emphasis>курсив</p><image l:href="#x"/><p>Два</p></section></body>
<binary id="x" content-type="image/png">${PNG_1X1_BASE64}</binary></FictionBook>`;
		const book = parseFb2String(xml);
		expect(book.paragraphs).toEqual(["Глава 1", "Раз курсив", "Два"]);
		expect(book.images!.map((i) => i.at)).toEqual([2]);
		expect(book.images![0].mime).toBe("image/png");
	});

	it(".fb2.zip через parseFile — рисунки на месте", async () => {
		const bytes = utf8(fb2WithImages());
		const plain = await parseFile(fileFrom(bytes, "Книга.fb2"));
		const zipped = await parseFile(fileFrom(await makeZip({ "Книга.fb2": bytes }), "Книга.fb2.zip"));
		expect(plain.images!.map((i) => i.at)).toEqual([0, 2, 3]);
		expect(zipped.images).toEqual(plain.images);
		expect(zipped.paragraphs).toEqual(IMG_PARAGRAPHS);
	});

	it("книга без рисунков не получает images", () => {
		expect(parseFb2String(withoutImages(fb2WithImages())).images).toBeUndefined();
	});
});

describe("FB2: подписи к рисункам", () => {
	const book = parseFb2String(fb2WithCaptions());
	const byAt = (at: number) => book.images!.filter((i) => i.at === at);

	it("subtitle под рисунком — подпись, даже длинная", () => {
		expect(byAt(2).map((i) => i.caption)).toEqual([true]);
	});

	it("<p><emphasis>…</emphasis></p> под рисунком — подпись, даже длинная", () => {
		expect(book.paragraphs[4].length).toBeGreaterThan(80);
		expect(byAt(4).map((i) => i.caption)).toEqual([true]);
	});

	it("«Рис. 2» обычным <p> — подпись", () => {
		expect(book.paragraphs[6]).toBe("Рис. 2");
		expect(byAt(6).map((i) => i.caption)).toEqual([true]);
	});

	it("длинный обычный абзац после рисунка — не подпись", () => {
		expect(byAt(8).length).toBe(1);
		expect("caption" in byAt(8)[0]).toBe(false);
	});

	it("атрибут title: текст остаётся на рисунке, в абзацы не попадает", () => {
		expect(byAt(9).map((i) => i.title)).toEqual(["Схема сна"]);
		expect("caption" in byAt(9)[0]).toBe(false);
		expect(book.paragraphs.join("\n")).not.toContain("Схема сна");
		// без title — поля нет
		expect("title" in byAt(8)[0]).toBe(false);
	});

	it("рисунок внутри абзаца подписи не получает, хотя дальше стоит «Рис. 3»", () => {
		expect(book.paragraphs[11]).toBe("Рис. 3");
		expect(byAt(11).length).toBe(1);
		expect("caption" in byAt(11)[0]).toBe(false);
	});

	it("заголовок главы сразу после рисунка — не подпись", () => {
		expect(book.paragraphs[12]).toBe("Глава 2");
		expect(byAt(12).length).toBe(1);
		expect("caption" in byAt(12)[0]).toBe(false);
	});

	it("из двух рисунков перед одним абзацем подпись у последнего; title первого остаётся", () => {
		const two = byAt(13);
		expect(two.length).toBe(2);
		expect("caption" in two[0]).toBe(false);
		expect(two[1].caption).toBe(true);
		expect(two[1].title).toBe("Вторая");
	});

	it("рисунок в самом конце (at === length) подписи не получает", () => {
		const xml = fb2WithCaptions().replace("</section></section></body>", `<image l:href="#pic10"/></section></section></body>`);
		const b = parseFb2String(xml);
		expect(b.images!.at(-1)!.at).toBe(b.paragraphs.length);
		expect("caption" in b.images!.at(-1)!).toBe(false);
	});

	it("paragraphs и toc те же, что у разбора без рисунков", () => {
		const bare = parseFb2String(fb2WithCaptions().replace(/<image[^>]*>/g, "").replace(/<binary[\s\S]*?<\/binary>/g, ""));
		expect(bare.images).toBeUndefined();
		expect(book.paragraphs).toEqual(bare.paragraphs);
		expect(book.toc).toEqual(bare.toc);
	});

	it("обычные рисунки (fb2WithImages) полей caption и title не получают", () => {
		for (const im of parseFb2String(fb2WithImages()).images!) {
			expect("caption" in im).toBe(false);
			expect("title" in im).toBe(false);
		}
	});
});
