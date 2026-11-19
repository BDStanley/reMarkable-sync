/**
 * Document Converter
 *
 * Full pipeline from reMarkable ZIP archive to PDF:
 * 1. Extract .rm files and metadata from ZIP
 * 2. Parse .rm files to get strokes and text
 * 3. Render to PDF with optional background
 */

import { PDFDocument } from "pdf-lib";
import {
	parseRmFile,
	pageDimensionsForPaper,
	type Page,
	type PaperSize,
} from "./rm-parser";
import {
	renderNotebookToPdf,
	computeTextBlocksBottomRawY,
	annotatePdfPage,
	markInkPages,
} from "./pdf-renderer";

// --- Data structures ---

export interface PageInfo {
	pageId: string;
	rmData: Uint8Array | null;
	template: string | null;
	verticalScroll: number | null;
}

export interface DocumentContent {
	docId: string;
	docType: "notebook" | "pdf" | "epub";
	name: string;
	pages: PageInfo[];
	originalPdf: Uint8Array | null;
	originalEpub: Uint8Array | null;
	metadata: Record<string, any>;
}

// --- Converter ---

export class DocumentConverter {
	private docId: string;
	private files: Map<string, Uint8Array>;
	private content: DocumentContent | null = null;
	private contentInfo: Record<string, any> = {};

	constructor(docId: string, files: Map<string, Uint8Array>) {
		this.docId = docId;
		this.files = files;
	}

	private textOf(name: string): string {
		const data = this.files.get(name);
		if (!data) return "";
		return new TextDecoder().decode(data);
	}

	async parse(): Promise<DocumentContent> {
		if (this.content) return this.content;

		const fileList = Array.from(this.files.keys());

		const metadata = this.readMetadata(fileList);
		this.contentInfo = this.readContentInfo(fileList);
		const docType = this.determineDocType(this.contentInfo, fileList);
		const pages = this.extractPages(fileList, this.contentInfo);
		const originalPdf = this.extractOriginalPdf(fileList);
		const originalEpub = this.extractOriginalEpub(fileList);

		this.content = {
			docId: this.docId,
			docType,
			name: metadata.visibleName ?? "Untitled",
			pages,
			originalPdf,
			originalEpub,
			metadata,
		};

		return this.content;
	}

	async convertToPdf(log?: (message: string) => void): Promise<Uint8Array> {
		const content = await this.parse();

		if (content.pages.length === 0) {
			throw new Error(
				`No pages found in document (type: ${content.docType}). ` +
					`Documents with no rendered pages cannot be converted to PDF.`
			);
		}

		const parsedPages: Page[] = [];

		for (let i = 0; i < content.pages.length; i++) {
			const pageInfo = content.pages[i];

			if (pageInfo.rmData) {
				try {
					const page = parseRmFile(new Uint8Array(pageInfo.rmData).buffer.slice(
						pageInfo.rmData.byteOffset,
						pageInfo.rmData.byteOffset + pageInfo.rmData.byteLength
					));
					page.pageId = pageInfo.pageId;

					// Extend the page height when stroke OR typed-text content
					// runs past the default page bounds (long / vertically
					// scrolled pages) so it is not clipped. See
					// extendPageHeightForContent.
					await extendPageHeightForContent(page);

					parsedPages.push(page);
				} catch {
					parsedPages.push(emptyPage(pageInfo.pageId));
				}
			} else {
				parsedPages.push(emptyPage(pageInfo.pageId));
			}
		}

		// Blank pages (no .rm file) take the paper size the rest of the document
		// was written on, so a Move notebook doesn't gain Paper Pro-sized pages.
		const docPaper = parsedPages.find((p) => p.paperSize)?.paperSize ?? null;
		if (docPaper) {
			for (const p of parsedPages) {
				if (!p.paperSize && p.layers.length === 0 && p.textBlocks.length === 0) {
					Object.assign(p, pageDimensionsForPaper(docPaper), { paperSize: docPaper });
				}
			}
		}
		if (content.originalPdf) {
			const annotated = await renderOntoOriginal(content.originalPdf, parsedPages, log);
			if (annotated) return annotated;
			// The original PDF couldn't be read (e.g. encrypted): fall back to
			// the annotations on their own, as before.
		}

		if (log) {
			const summary = describeLayout(parsedPages, []);
			if (summary) log(summary);
		}
		return renderNotebookToPdf(parsedPages);
	}

	// --- Archive processing ---

	private readMetadata(fileList: string[]): Record<string, any> {
		for (const name of fileList) {
			if (name.endsWith(".metadata")) {
				try {
					return JSON.parse(this.textOf(name));
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private readContentInfo(fileList: string[]): Record<string, any> {
		for (const name of fileList) {
			if (name.endsWith(".content")) {
				try {
					return JSON.parse(this.textOf(name));
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private determineDocType(
		contentInfo: Record<string, any>,
		fileList: string[]
	): "notebook" | "pdf" | "epub" {
		for (const name of fileList) {
			if (name.endsWith(".pdf")) return "pdf";
			if (name.endsWith(".epub")) return "epub";
		}
		const fileType = contentInfo.fileType ?? "";
		if (fileType === "pdf") return "pdf";
		if (fileType === "epub") return "epub";
		return "notebook";
	}

	private extractPages(
		fileList: string[],
		contentInfo: Record<string, any>
	): PageInfo[] {
		let pageIds: string[] = contentInfo.pages ?? [];

		// Check cPages (newer format) and extract per-page metadata
		const cPages = contentInfo.cPages;
		const pageVerticalScroll = new Map<string, number>();
		if (cPages && cPages.pages) {
			pageIds = cPages.pages.map((p: any) => {
				const id = typeof p === "object" ? p.id ?? p : p;
				if (typeof p === "object" && p.verticalScroll?.value != null) {
					pageVerticalScroll.set(id, p.verticalScroll.value);
				}
				return id;
			});
		}

		// Fallback: scan for .rm files
		if (pageIds.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					if (!pageIds.includes(stem)) {
						pageIds.push(stem);
					}
				}
			}
		}

		const pages: PageInfo[] = [];

		for (const pageId of pageIds) {
			const pageInfo: PageInfo = {
				pageId,
				rmData: null,
				template: null,
				verticalScroll: pageVerticalScroll.get(pageId) ?? null,
			};

			// Find .rm file
			for (const name of fileList) {
				if (name.endsWith(`${pageId}.rm`)) {
					pageInfo.rmData = this.files.get(name) ?? null;
					break;
				}
			}

			// Find page metadata
			for (const name of fileList) {
				if (name.includes(`${pageId}-metadata.json`)) {
					try {
						const meta = JSON.parse(this.textOf(name));
						pageInfo.template = meta.template ?? null;
					} catch {
						// ignore
					}
				}
			}

			pages.push(pageInfo);
		}

		// Final fallback: grab any .rm files
		if (pages.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					const rmData = this.files.get(name) ?? null;
					pages.push({ pageId: stem, rmData, template: null, verticalScroll: null });
				}
			}
		}

		return pages;
	}

	private extractOriginalPdf(fileList: string[]): Uint8Array | null {
		for (const name of fileList) {
			if (name.endsWith(".pdf") && !name.endsWith("-metadata.pdf")) {
				return this.files.get(name) ?? null;
			}
		}
		return null;
	}

	private extractOriginalEpub(fileList: string[]): Uint8Array | null {
		for (const name of fileList) {
			if (name.endsWith(".epub")) {
				return this.files.get(name) ?? null;
			}
		}
		return null;
	}
}

// Extend the page height when stroke OR typed-text content runs past the default
// page bounds (long / vertically scrolled pages) so it is not clipped in the
// rendered PDF. This is content-driven and independent of the optional
// `verticalScroll` metadata — long pages that lack it would otherwise be
// silently truncated.
//
// Both strokes and typed text are reduced to a single `maxY` in raw-Y units:
// strokes contribute their lowest point directly, while a text block's rendered
// bottom is `posY + renderedHeightPt / COORD_SCALE` (see
// computeTextBlocksBottomRawY). This matters most for mixed pages where the
// typed text sits BELOW where the strokes end — previously only strokes were
// measured, so that text was cut off.
//
// Pages whose content stays within the default height are left untouched, so it
// can never affect normal single-screen pages (maxY only ever grows, and the
// height is reassigned only when it exceeds the threshold). The 0.885 factor
// maps raw coordinate bounds to reMarkable's export bounds (calibrated against
// reference_sheets/). Shared with the re-render.ts reference tool so both paths
// stay in sync.
export async function extendPageHeightForContent(page: Page): Promise<void> {
	const defaultHeight = page.height; // 1872 for standard pages
	const threshold = defaultHeight * 1.05;
	let maxY = 0;
	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			for (const pt of stroke.points) {
				if (pt.y > maxY) maxY = pt.y;
			}
		}
	}
	// Typed text is positioned independently of strokes and can extend below
	// them (or below the default height); fold its rendered bottom into maxY.
	const textBottomRawY = await computeTextBlocksBottomRawY(page);
	if (textBottomRawY > maxY) maxY = textBottomRawY;
	const scaledHeight = maxY * 0.885;
	if (scaledHeight > threshold) {
		page.height = scaledHeight;
	}
}

// Paper sizes reported in SceneInfo by the tablets we know about.
const KNOWN_PAPER: Record<string, string> = {
	"1620x2160": "Paper Pro",
	"1404x1872": "reMarkable 2 or Paper Pro Move",
};

function paperLabel(paper: PaperSize | null | undefined): string {
	if (!paper) return "no paper size recorded";
	const key = `${paper.width}x${paper.height}`;
	const name = KNOWN_PAPER[key];
	return name ? `${key} (${name})` : key;
}

/**
 * One-line description of how a document was laid out, for the sync log. Only
 * produced when something differs from a plain Paper Pro notebook, so routine
 * syncs stay quiet.
 */
function describeLayout(pages: Page[], pdfPageSizes: string[]): string | null {
	const papers = new Set(pages.filter(pageHasContent).map((p) => paperLabel(p.paperSize)));
	if (papers.size === 0) papers.add(paperLabel(pages[0]?.paperSize));
	const bgSizes = new Set(pdfPageSizes);
	const papersText = Array.from(papers).join(", ");
	if (bgSizes.size === 0 && papersText === paperLabel({ width: 1620, height: 2160 })) {
		return null;
	}
	const parts = [`paper ${papersText}`];
	if (bgSizes.size > 0) parts.push(`PDF pages ${Array.from(bgSizes).join(", ")}`);
	return `Layout: ${parts.join("; ")}`;
}

function pageHasContent(page: Page): boolean {
	return page.layers.length > 0 || page.textBlocks.length > 0;
}

/**
 * Add the annotations to the original PDF in place: load it once, draw on the
 * pages that have writing, save once. Pages without writing are left exactly as
 * they were, and fonts/images the PDF shares between pages stay shared.
 *
 * (Splitting the PDF into one-page documents and joining them again, as before,
 * gave every page its own copy of those shared resources — a 4 MB, 60-page PDF
 * came back at 260 MB — and re-read the whole PDF once per page.)
 *
 * Page i of the reMarkable document is page i of the PDF, as before. Extra
 * pages added on the tablet are appended as plain notebook pages; PDF pages
 * beyond the document's page list are dropped. Returns null if the PDF can't be
 * loaded or saved.
 */
async function renderOntoOriginal(
	pdfData: Uint8Array,
	pages: Page[],
	log?: (message: string) => void
): Promise<Uint8Array | null> {
	let doc: PDFDocument;
	try {
		doc = await PDFDocument.load(pdfData);
	} catch {
		return null;
	}

	const pdfPageCount = doc.getPageCount();
	const sizes = new Set<string>();
	for (let i = 0; i < pages.length && i < pdfPageCount; i++) {
		const pdfPage = doc.getPage(i);
		try {
			const drawn = await annotatePdfPage(doc, pdfPage, pages[i]);
			if (drawn) {
				const { width, height } = pdfPage.getCropBox();
				sizes.add(`${Math.round(width)}x${Math.round(height)}pt`);
			}
		} catch {
			// Leave this page as it was rather than failing the document.
		}
	}

	for (let i = pdfPageCount - 1; i >= pages.length; i--) {
		doc.removePage(i);
	}

	if (pages.length > pdfPageCount) {
		const extra = await PDFDocument.load(await renderNotebookToPdf(pages.slice(pdfPageCount)));
		const copied = await doc.copyPages(extra, extra.getPageIndices());
		for (const p of copied) doc.addPage(p);
	}

	if (log) {
		if (sizes.size === 0 && doc.getPageCount() > 0) {
			const { width, height } = doc.getPage(0).getCropBox();
			sizes.add(`${Math.round(width)}x${Math.round(height)}pt`);
		}
		const summary = describeLayout(pages, Array.from(sizes));
		if (summary) log(summary);
	}

	markInkPages(doc, pages);
	try {
		return await doc.save();
	} catch {
		return null;
	}
}

function emptyPage(pageId: string): Page {
	return {
		pageId,
		layers: [],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: 1872,
	};
}

export async function convertDocument(
	docId: string,
	files: Map<string, Uint8Array>,
	log?: (message: string) => void
): Promise<Uint8Array> {
	const converter = new DocumentConverter(docId, files);
	return converter.convertToPdf(log);
}
