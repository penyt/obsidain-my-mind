//One-shot text node sizing after editing finishes

//------------ import dependencies ------------
import { CanvasNode } from './canvas-types';

//------------ sizing constants ------------
const MIN_WIDTH = 60;
const MAX_WIDTH = 420;
const MIN_HEIGHT = 52;
const HORIZONTAL_SPACE = 40;
const VERTICAL_SPACE = 24;
const HEIGHT_SAFETY_PADDING = 4;
const FALLBACK_FONT_SIZE = 16;
const FALLBACK_FONT_FAMILY = 'var(--font-text), sans-serif';

// Font information used by CanvasRenderingContext2D.measureText().
interface MeasuredTextStyle {
	font: string;
	fontSize: number;
	lineHeight: number;
}

/**
 * One-shot text sizing used after editing finishes.
 * It intentionally avoids DOM cloning, polling, and per-keystroke resizing.
 */
export function fitTextNodeToContent(
	node: CanvasNode,
	textOverride?: string | null,
	options: { forceRender?: boolean } = {},
): boolean {
	if (node.getData().type !== 'text') return false;

	const text = getText(node, textOverride);
	if (text.trim().length === 0) {
		return resizeNode(node, MIN_WIDTH, MIN_HEIGHT, options);
	}

	const style = getMeasuredTextStyle(node);
	const context = getMeasureContext(node);
	context.font = style.font;

	const lines = text.split('\n');
	const naturalWidth = Math.max(...lines.map((line) => measureLineWidth(context, line)));
	const width = clamp(Math.ceil(naturalWidth + HORIZONTAL_SPACE), MIN_WIDTH, MAX_WIDTH);
	const contentWidth = Math.max(1, width - HORIZONTAL_SPACE);
	const wrappedLineCount = getWrappedLineCount(context, lines, contentWidth);
	const height = Math.max(
		MIN_HEIGHT,
		Math.ceil(wrappedLineCount * style.lineHeight + VERTICAL_SPACE + HEIGHT_SAFETY_PADDING),
	);

	return resizeNode(node, width, height, options);
}

// Apply size only when it meaningfully changed to avoid noisy history/rendering.
function resizeNode(
	node: CanvasNode,
	width: number,
	height: number,
	options: { forceRender?: boolean } = {},
): boolean {
	const nextWidth = Math.round(width);
	const nextHeight = Math.round(height);
	const changed = Math.abs(node.width - nextWidth) >= 2 || Math.abs(node.height - nextHeight) >= 2;
	if (!changed) {
		if (options.forceRender) node.render?.();
		return false;
	}

	node.setData({
		...node.getData(),
		width: nextWidth,
		height: nextHeight,
	}, false);
	node.render?.();
	return changed;
}

// Prefer live editor text, then persisted data, then preview text.
function getText(node: CanvasNode, textOverride?: string | null): string {
	if (typeof textOverride === 'string') return textOverride;

	const editorDocument = node.isEditing ? getEditorDocument(node) : null;
	const editorLines = editorDocument ? getEditorLines(editorDocument) : null;
	if (editorLines) return editorLines.join('\n');

	const dataText = node.getData().text;
	if (typeof dataText === 'string') return dataText;

	if (typeof node.text === 'string') return node.text;

	const previewText = node.contentEl?.querySelector('.markdown-preview-view')?.textContent;
	if (typeof previewText === 'string') return previewText;

	return '';
}

function getEditorDocument(node: CanvasNode): Document | null {
	const iframe = node.nodeEl?.querySelector('iframe');
	return iframe?.contentDocument ?? null;
}

function getEditorLines(document: Document): string[] | null {
	const lines = Array.from(document.querySelectorAll('.cm-line'))
		.filter((element): element is HTMLElement => element.instanceOf(HTMLElement));
	if (lines.length === 0) return null;
	return lines.map((line) => line.textContent ?? '');
}

// Read theme font values when available, with stable fallbacks.
function getMeasuredTextStyle(node: CanvasNode): MeasuredTextStyle {
	const source = getFontSource(node);
	const style = source?.ownerDocument.defaultView?.getComputedStyle(source) ?? null;
	const fontSize = parsePx(style?.fontSize) ?? FALLBACK_FONT_SIZE;
	const lineHeight = parseLineHeight(style?.lineHeight, fontSize);
	const fontStyle = style?.fontStyle || 'normal';
	const fontWeight = style?.fontWeight || 'normal';
	const fontFamily = style?.fontFamily || FALLBACK_FONT_FAMILY;

	return {
		font: `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`,
		fontSize,
		lineHeight,
	};
}

function getFontSource(node: CanvasNode): HTMLElement | null {
	const previewText = node.contentEl?.querySelector('.markdown-preview-view p, .markdown-preview-view li, .markdown-preview-view');
	if (previewText?.instanceOf(HTMLElement)) return previewText;

	const editorDocument = getEditorDocument(node);
	const editorContent = editorDocument?.querySelector('.cm-content, .cm-line');
	if (editorContent?.instanceOf(HTMLElement)) return editorContent;

	return node.contentEl ?? node.nodeEl ?? null;
}

// Use an offscreen canvas context only for text measurement.
function getMeasureContext(node: CanvasNode): CanvasRenderingContext2D {
	const document = node.nodeEl?.ownerDocument ?? activeDocument;
	const canvas = document.body.createEl('canvas');
	canvas.detach();
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not create text measurement context.');
	return context;
}

function measureLineWidth(context: CanvasRenderingContext2D, line: string): number {
	return context.measureText(line).width;
}

// Estimate soft-wrapped visual line count for the computed content width.
function getWrappedLineCount(context: CanvasRenderingContext2D, lines: string[], contentWidth: number): number {
	return lines.reduce((count, line) => count + getWrappedManualLineCount(context, line, contentWidth), 0);
}

function getWrappedManualLineCount(context: CanvasRenderingContext2D, line: string, contentWidth: number): number {
	if (line.length === 0) return 1;
	if (measureLineWidth(context, line) <= contentWidth) return 1;

	const tokens = splitByWordsAndSpaces(line);
	let lineCount = 1;
	let current = '';

	for (const token of tokens) {
		if (token.length === 0) continue;

		if (measureLineWidth(context, token) > contentWidth) {
			if (current.length > 0) {
				lineCount += 1;
				current = '';
			}
			const wrappedLongToken = wrapLongToken(context, token, contentWidth);
			lineCount += wrappedLongToken.lineCount - 1;
			current = wrappedLongToken.remainder;
			continue;
		}

		const next = current + token;
		if (current.length > 0 && measureLineWidth(context, next) > contentWidth) {
			lineCount += 1;
			current = token.trimStart();
		} else {
			current = next;
		}
	}

	return lineCount;
}

function splitByWordsAndSpaces(line: string): string[] {
	return line.split(/(\s+)/).filter((token) => token.length > 0);
}

function wrapLongToken(
	context: CanvasRenderingContext2D,
	token: string,
	contentWidth: number,
): { lineCount: number; remainder: string } {
	const graphemes = splitGraphemes(token);
	let lineCount = 1;
	let current = '';

	for (const grapheme of graphemes) {
		const next = current + grapheme;
		if (current.length > 0 && measureLineWidth(context, next) > contentWidth) {
			lineCount += 1;
			current = grapheme;
		} else {
			current = next;
		}
	}

	return { lineCount, remainder: current };
}

function splitGraphemes(text: string): string[] {
	type SegmenterConstructor = new (
		locale?: string,
		options?: { granularity?: 'grapheme' },
	) => { segment(input: string): Iterable<{ segment: string }> };
	const segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
	if (!segmenter) return Array.from(text);
	return Array.from(new segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
}

function parseLineHeight(value: string | undefined, fontSize: number): number {
	if (!value || value === 'normal') return fontSize * 1.5;
	const parsed = parsePx(value);
	return parsed ?? fontSize * 1.5;
}

function parsePx(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
