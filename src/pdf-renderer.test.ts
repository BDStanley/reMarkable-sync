import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { PDFDocument, degrees } from "pdf-lib";

import { parseRmFile, PenType, type Page, type Stroke } from "./rm-parser";
import { renderPageToPdf, growForInk, COORD_SCALE } from "./pdf-renderer";

// --- Helpers ---

// The Paper Pro Move reports the reMarkable 2's paper size in SceneInfo.
const MOVE_PAPER = { width: 1404, height: 1872 };

/** A minimal v6 .rm file holding just a SceneInfo block with a paper size. */
function rmWithPaperSize(width: number, height: number): ArrayBuffer {
	const header = new Uint8Array(43);
	header.set(new TextEncoder().encode("reMarkable .lines file, version=6"));
	const content: number[] = [];
	const u32 = (v: number) => content.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
	// tag 1, Length4: current-layer LWW value (opaque to the parser — skipped)
	content.push(0x1c);
	u32(3);
	content.push(0x00, 0x00, 0x00);
	// tag 5, Length4: paper size as two u32s
	content.push(0x5c);
	u32(8);
	u32(width);
	u32(height);
	const block: number[] = [];
	const len = content.length;
	block.push(len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff);
	block.push(0, 0, 1, 0x0d, ...content);
	// Trailing padding so the parser's 8-byte lookahead loop terminates cleanly.
	const out = new Uint8Array(header.length + block.length + 8);
	out.set(header, 0);
	out.set(block, header.length);
	return out.buffer;
}

function line(points: [number, number][]): Stroke {
	return {
		penType: PenType.FINELINER_2,
		color: 0,
		colorArgb: null,
		thicknessScale: 1,
		points: points.map(([x, y]) => ({ x, y, speed: 0, direction: 0, width: 16, pressure: 100 })),
	};
}

function pageWith(strokes: Stroke[], paperSize = MOVE_PAPER): Page {
	return {
		pageId: "p",
		layers: [{ name: "", strokes }],
		textSpans: [],
		textBlocks: [],
		width: paperSize.width * (1404 / 1620),
		height: paperSize.height * (1404 / 1620),
		paperSize,
	};
}

async function blankPdf(width: number, height: number, rotation = 0): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([width, height]);
	if (rotation) page.setRotation(degrees(rotation));
	return doc.save();
}

async function firstPage(bytes: Uint8Array) {
	const doc = await PDFDocument.load(bytes);
	return doc.getPage(0);
}

// --- Paper size parsing ---

test("SceneInfo paper size is read from a Paper Pro reference page", () => {
	const dir = path.join("reference_sheets", "Fineliner");
	const rm = fs.readdirSync(dir).find((f) => f.endsWith(".rm"))!;
	const b = fs.readFileSync(path.join(dir, rm));
	const page = parseRmFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
	assert.deepEqual(page.paperSize, { width: 1620, height: 2160 });
	// Paper Pro keeps the historical 1404x1872 page basis exactly.
	assert.equal(page.width, 1404);
	assert.equal(page.height, 1872);
});

test("a non-Paper Pro paper size is picked up and scales the page", () => {
	const page = parseRmFile(rmWithPaperSize(954, 1696));
	assert.deepEqual(page.paperSize, { width: 954, height: 1696 });
	assert.ok(Math.abs(page.width - 954 * (1404 / 1620)) < 1e-9);
	assert.ok(Math.abs(page.height - 1696 * (1404 / 1620)) < 1e-9);
});

// --- Notebook pages ---

test("a Move notebook page is rendered at the Move's paper size", async () => {
	const page = pageWith([line([[-400, 100], [400, 1600]])]);
	const out = await firstPage(await renderPageToPdf(page));
	const { width, height } = out.getSize();
	assert.ok(Math.abs(width - MOVE_PAPER.width * COORD_SCALE) < 0.01, `width ${width}`);
	assert.ok(Math.abs(height - MOVE_PAPER.height * COORD_SCALE) < 0.01, `height ${height}`);
});

// --- PDF-backed pages ---

test("annotations on a Move-sized PDF keep the PDF's page size", async () => {
	// A 540x960pt template; ink right up to 12pt from every edge.
	const hw = (540 / 2 - 12) / COORD_SCALE;
	const h = (960 - 12) / COORD_SCALE;
	const page = pageWith([line([[-hw, 12 / COORD_SCALE], [hw, h]])]);
	const out = await firstPage(await renderPageToPdf(page, await blankPdf(540, 960)));
	assert.deepEqual(out.getSize(), { width: 540, height: 960 });
	const crop = out.getCropBox();
	assert.deepEqual([crop.x, crop.y, crop.width, crop.height], [0, 0, 540, 960]);
});

test("ink written outside the PDF page grows the page instead of being clipped", async () => {
	const below = (960 + 40) / COORD_SCALE; // 40pt under the page
	const left = -(540 / 2 + 30) / COORD_SCALE; // 30pt left of the page
	const page = pageWith([line([[left, below], [0, 100]])]);
	const out = await firstPage(await renderPageToPdf(page, await blankPdf(540, 960)));
	const crop = out.getCropBox();
	assert.ok(crop.x <= -30, `crop starts at x=${crop.x}`);
	assert.ok(crop.y <= -40, `crop starts at y=${crop.y}`);
	assert.ok(crop.x + crop.width >= 540 && crop.y + crop.height >= 960, "original page still covered");
});

test("strokes that only touch the page edge do not grow the page", () => {
	const page = pageWith([line([[-810, 0], [810, 2160]])], { width: 1620, height: 2160 });
	const geo = { originX: 257, topY: 685.333, pageWidthPt: 514, pageHeightPt: 685.333 };
	const { growth } = growForInk(page, geo);
	assert.deepEqual(growth, { left: 0, right: 0, bottom: 0, top: 0 });
});

test("a rotated PDF page keeps its size and rotation", async () => {
	const page = pageWith([line([[-200, 100], [200, 400]])]);
	const out = await firstPage(await renderPageToPdf(page, await blankPdf(540, 960, 90)));
	assert.equal(out.getRotation().angle, 90);
	assert.deepEqual(out.getSize(), { width: 540, height: 960 });
});
