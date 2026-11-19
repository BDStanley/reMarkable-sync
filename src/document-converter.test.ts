/**
 * Tests for the document converter.
 *
 * Covers two regression areas:
 *   - Content-driven page-height extension (long / vertically-scrolled pages
 *     were clipped because extension was gated behind optional metadata and
 *     ignored typed text).
 *   - Conversion of un-annotated imported PDFs (issue #16), which used to fail
 *     the whole document with "Can't embed page with missing Contents".
 *   - Annotated multi-page PDFs are annotated in place, so shared fonts/images
 *     aren't copied onto every page and internal links keep working.
 *
 * Run: npx tsx --test src/document-converter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import { convertDocument, extendPageHeightForContent } from "./document-converter";
import { computeTextBlocksBottomRawY } from "./pdf-renderer";
import type { Page, Stroke, TextBlock } from "./rm-parser";

const DEFAULT_HEIGHT = 1872;
// A page is extended only when maxY * 0.885 exceeds DEFAULT_HEIGHT * 1.05.
const THRESHOLD_MAX_Y = (DEFAULT_HEIGHT * 1.05) / 0.885; // ≈ 2221

function strokeReachingY(maxY: number): Stroke {
	return {
		penType: 0,
		color: 0,
		colorArgb: null,
		thicknessScale: 1,
		points: [
			{ x: 0, y: 0, speed: 0, direction: 0, width: 1, pressure: 1 },
			{ x: 0, y: maxY, speed: 0, direction: 0, width: 1, pressure: 1 },
		],
	};
}

// A text block of `lines` single-word lines (no wrapping, so the rendered line
// count is deterministic regardless of glyph widths) anchored at `posY`.
function textBlockAt(posY: number, lines: number, text?: string): TextBlock {
	return {
		text: text ?? Array.from({ length: lines }, () => "x").join("\n"),
		posX: -576,
		posY,
		width: 1152,
		paragraphStyles: new Map<number, number>(),
	};
}

function makePage(opts: { strokeMaxY?: number; textBlocks?: TextBlock[] }): Page {
	return {
		pageId: "page",
		layers: opts.strokeMaxY
			? [{ name: "", strokes: [strokeReachingY(opts.strokeMaxY)] }]
			: [],
		textSpans: [],
		textBlocks: opts.textBlocks ?? [],
		width: 1404,
		height: DEFAULT_HEIGHT,
	};
}

// --- Stroke-driven extension (existing behaviour, now async) ---

test("normal-height content leaves the page height unchanged", async () => {
	const page = makePage({ strokeMaxY: 1500 });
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("long page (no verticalScroll metadata) is extended so content isn't clipped", async () => {
	const maxY = 3000;
	assert.ok(maxY > THRESHOLD_MAX_Y, "test fixture must exceed the extension threshold");
	const page = makePage({ strokeMaxY: maxY });
	await extendPageHeightForContent(page);
	assert.equal(page.height, maxY * 0.885);
	assert.ok(page.height > DEFAULT_HEIGHT, "long page must be taller than the default");
});

test("content just past the screen but under the threshold is not extended", async () => {
	// 2000 * 0.885 = 1770, which is below DEFAULT_HEIGHT * 1.05 (= 1965.6).
	const page = makePage({ strokeMaxY: 2000 });
	assert.ok(2000 < THRESHOLD_MAX_Y);
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("a page with no strokes or text keeps the default height", async () => {
	const page = makePage({});
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

// --- Typed-text-driven extension (the new fix) ---

test("typed text below the strokes extends the page so it isn't clipped", async () => {
	// Strokes end well within a normal page; a long text block sits below them.
	const tb = textBlockAt(1800, 12);
	const page = makePage({ strokeMaxY: 1500, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(
		textBottom > THRESHOLD_MAX_Y,
		"fixture: text must extend past the threshold the strokes don't reach"
	);
	assert.ok(textBottom > 1500, "fixture: text must extend below the strokes");

	await extendPageHeightForContent(page);
	// Height is driven by the (lower) text bottom, not the strokes.
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
	assert.ok(page.height > DEFAULT_HEIGHT, "mixed text+drawing page must grow to fit the text");
});

test("text extent is honoured even when strokes already trigger extension", async () => {
	// Strokes already exceed the threshold, but the text reaches even lower —
	// the page must grow to the text, proving text isn't dropped once strokes
	// alone would extend the page.
	const tb = textBlockAt(2600, 4);
	const page = makePage({ strokeMaxY: 2300, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom > 2300, "fixture: text must reach below the strokes");

	await extendPageHeightForContent(page);
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
});

test("short typed text near the top neither shrinks nor extends a normal page", async () => {
	const tb = textBlockAt(234, 3); // a few lines near the default text anchor
	const page = makePage({ textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom < THRESHOLD_MAX_Y, "fixture: short text must stay under the threshold");

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("empty / whitespace-only text blocks are ignored", async () => {
	// Anchored very low, but with no real content — must contribute nothing,
	// mirroring renderTextBlock's `if (!tb.text.trim()) return`.
	const tb = textBlockAt(3000, 0, "   \n  ");
	const page = makePage({ textBlocks: [tb] });

	assert.equal(await computeTextBlocksBottomRawY(page), 0);

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

// --- Un-annotated imported PDFs (issue #16) ---
//
// A PDF imported to the reMarkable but never drawn on has pages with no .rm
// stroke data, so each page renders to a blank overlay with no /Contents
// stream. Merging that overlay onto the original PDF page used to throw pdf-lib's
// "Can't embed page with missing Contents" (the check runs lazily during save),
// and a missing `await` in mergeWithBackground let that rejection escape its
// try/catch and fail the whole document — every un-annotated PDF errored out.
// convertDocument must now produce the original PDF unchanged for these.

// A minimal reMarkable archive for an imported PDF with `pageCount` pages and no
// annotations, mirroring what the sync downloads: a .content listing the pages,
// a .metadata, and the original .pdf — but no per-page .rm files.
async function unannotatedPdfArchive(
	docId: string,
	pageSizes: [number, number][]
): Promise<Map<string, Uint8Array>> {
	const original = await PDFDocument.create();
	for (const [w, h] of pageSizes) {
		// Draw real content so the *background* has a /Contents stream; the bug is
		// about the blank annotation overlay, not the page being merged onto.
		original.addPage([w, h]).drawText("original page content", { x: 40, y: h - 60 });
	}
	const pdfBytes = new Uint8Array(await original.save());

	const pageIds = pageSizes.map((_, i) => `page-${i}`);
	const enc = (s: string) => new TextEncoder().encode(s);

	const files = new Map<string, Uint8Array>();
	files.set(`${docId}.pdf`, pdfBytes);
	files.set(`${docId}.metadata`, enc(JSON.stringify({ visibleName: "Imported PDF", type: "DocumentType" })));
	files.set(`${docId}.content`, enc(JSON.stringify({ fileType: "pdf", pages: pageIds })));
	// Deliberately NO `${docId}/<pageId>.rm` files — the pages are un-annotated.
	return files;
}

test("un-annotated single-page PDF converts and preserves the original page", async () => {
	const files = await unannotatedPdfArchive("doc1", [[612, 792]]);

	// Before the fix this rejected with "Can't embed page with missing Contents".
	const out = await convertDocument("doc1", files);

	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 1);
	// The output keeps the original PDF page size, proving the background was kept
	// rather than replaced by the 1404x1872 blank-annotation default.
	const { width, height } = doc.getPage(0).getSize();
	assert.equal(Math.round(width), 612);
	assert.equal(Math.round(height), 792);
});

test("un-annotated multi-page PDF converts every page", async () => {
	const files = await unannotatedPdfArchive("doc2", [
		[612, 792],
		[595, 842],
		[612, 792],
	]);

	const out = await convertDocument("doc2", files);

	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), 3);
	// Each background page is preserved at its own size (incl. the A4 middle page).
	const sizes = doc.getPages().map((p) => {
		const s = p.getSize();
		return [Math.round(s.width), Math.round(s.height)];
	});
	assert.deepEqual(sizes, [
		[612, 792],
		[595, 842],
		[612, 792],
	]);
});

// --- Large annotated PDFs are annotated in place ---

/** An incompressible RGB PNG, so a shared image dominates the PDF's size. */
function noisePng(width: number, height: number): Uint8Array {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf: Buffer) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	let seed = 12345;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let i = 0; i < raw.length; i++) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		raw[i] = i % (width * 3 + 1) === 0 ? 0 : seed >>> 24;
	}
	return new Uint8Array(Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]));
}

function referenceRm(name: string): Uint8Array {
	const dir = path.join("reference_sheets", name);
	const file = fs.readdirSync(dir).find((f) => f.endsWith(".rm"))!;
	return new Uint8Array(fs.readFileSync(path.join(dir, file)));
}

test("annotating one page of a large PDF keeps shared resources shared", async () => {
	const pageCount = 40;
	const original = await PDFDocument.create();
	const image = await original.embedPng(noisePng(600, 600)); // ~1 MB
	for (let i = 0; i < pageCount; i++) {
		original.addPage([540, 960]).drawImage(image, { x: 40, y: 400, width: 460, height: 460 });
	}
	const pdfBytes = new Uint8Array(await original.save());

	const enc = (s: string) => new TextEncoder().encode(s);
	const pageIds = Array.from({ length: pageCount }, (_, i) => `page-${i}`);
	const files = new Map<string, Uint8Array>();
	files.set("big.pdf", pdfBytes);
	files.set("big.metadata", enc(JSON.stringify({ visibleName: "Big PDF", type: "DocumentType" })));
	files.set("big.content", enc(JSON.stringify({ fileType: "pdf", pages: pageIds })));
	files.set("big/page-1.rm", referenceRm("Fineliner"));

	const out = await convertDocument("big", files);
	const doc = await PDFDocument.load(out);
	assert.equal(doc.getPageCount(), pageCount);
	// Splitting and re-joining the PDF used to give every page its own copy of
	// the image (~40x the input). In place, only the ink (~200 KB here) is added.
	assert.ok(
		out.length < pdfBytes.length + 500_000,
		`output ${out.length} bytes vs input ${pdfBytes.length}`
	);
	// Only the annotated page gains the annotation layer.
	const xObjects = (i: number) =>
		(doc.getPage(i).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict)?.keys().length) ?? 0;
	assert.equal(xObjects(1), xObjects(0) + 1);
	assert.equal(xObjects(2), xObjects(0));
});

test("internal links in an annotated PDF still point at their pages", async () => {
	const original = await PDFDocument.create();
	const pages = [0, 1, 2].map(() => original.addPage([540, 960]));
	// A GoTo link on page 1 pointing at page 3.
	const link = original.context.obj({
		Type: "Annot",
		Subtype: "Link",
		Rect: [40, 40, 200, 80],
		Border: [0, 0, 0],
		Dest: [pages[2].ref, "XYZ", null, null, null],
	});
	pages[0].node.set(PDFName.of("Annots"), original.context.obj([original.context.register(link)]));
	const pdfBytes = new Uint8Array(await original.save());

	const enc = (s: string) => new TextEncoder().encode(s);
	const files = new Map<string, Uint8Array>();
	files.set("linked.pdf", pdfBytes);
	files.set("linked.metadata", enc(JSON.stringify({ visibleName: "Linked", type: "DocumentType" })));
	files.set("linked.content", enc(JSON.stringify({ fileType: "pdf", pages: ["a", "b", "c"] })));
	files.set("linked/a.rm", referenceRm("Fineliner"));

	const doc = await PDFDocument.load(await convertDocument("linked", files));
	const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
	const dest = (annots.lookup(0, PDFDict)).lookup(PDFName.of("Dest"), PDFArray);
	assert.equal(dest.get(0), doc.getPage(2).ref, "link still targets the third page");
});
