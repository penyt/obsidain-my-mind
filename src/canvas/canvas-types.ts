//Private Canvas runtime type declarations used by My Mind

//------------ import dependencies ------------
import { Scope, TextFileView, TFile } from 'obsidian';

//------------ shared primitive types ------------
export type CanvasNodeSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEdgeEnd = 'none' | 'arrow';

export interface CanvasPosition {
	x: number;
	y: number;
}

export interface CanvasSize {
	width: number;
	height: number;
}

export interface CanvasBBox {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

// Raw node data persisted inside the .canvas file.
export interface CanvasNodeData {
	id: string;
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	[key: string]: unknown;
}

// Raw edge data persisted inside the .canvas file.
export interface CanvasEdgeData {
	id: string;
	fromNode: string;
	fromSide?: CanvasNodeSide;
	fromEnd?: CanvasEdgeEnd;
	toNode: string;
	toSide?: CanvasNodeSide;
	toEnd?: CanvasEdgeEnd;
	color?: string;
	label?: string;
	[key: string]: unknown;
}

export interface CanvasData {
	nodes: CanvasNodeData[];
	edges: CanvasEdgeData[];
	[key: string]: unknown;
}

//------------ Canvas runtime objects ------------
// Common runtime shape shared by Canvas nodes and edges.
export interface CanvasElement {
	id: string;
	initialized?: boolean;
	canvas: Canvas;
	getBBox(): CanvasBBox;
	getData(): CanvasNodeData | CanvasEdgeData;
	setData(data: CanvasNodeData | CanvasEdgeData, addHistory?: boolean): void;
	render?(): void;
}

// Runtime Canvas node object. Many fields are private and may be missing.
export interface CanvasNode extends CanvasElement {
	isEditing?: boolean;
	isFocused?: boolean;
	nodeEl?: HTMLElement;
	contentEl?: HTMLElement;
	containerEl?: HTMLElement;
	child?: {
		editMode?: {
			cm?: {
				dom?: HTMLElement;
			};
		};
	};
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
	text?: string;
	file?: TFile;
	getData(): CanvasNodeData;
	setData(data: CanvasNodeData, addHistory?: boolean): void;
	startEditing?: () => void;
	setIsEditing?: (editing: boolean) => void;
	focus?: () => void;
	blur?: () => void;
	moveTo?: (position: CanvasPosition) => void;
}

// Runtime Canvas edge object with optional resolved from/to node references.
export interface CanvasEdge extends CanvasElement {
	from?: { node: CanvasNode; side?: CanvasNodeSide; end?: CanvasEdgeEnd };
	to?: { node: CanvasNode; side?: CanvasNodeSide; end?: CanvasEdgeEnd };
	getData(): CanvasEdgeData;
	setData(data: CanvasEdgeData, addHistory?: boolean): void;
}

export interface CanvasConfig {
	defaultTextNodeDimensions?: CanvasSize;
}

// Main Canvas runtime object used by Obsidian Canvas view.
export interface Canvas {
	view: CanvasView;
	config?: CanvasConfig;
	nodes: Map<string, CanvasNode>;
	edges: Map<string, CanvasEdge>;
	selection: Set<CanvasElement>;
	readonly?: boolean;
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	quickSettingsButton?: HTMLElement;
	canvasControlsEl?: HTMLElement;
	getData(): CanvasData;
	importData(data: { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] }, clearCanvas?: boolean, silent?: boolean): void;
	createTextNode(options: {
		pos: CanvasPosition;
		size: CanvasSize;
		text?: string;
		focus?: boolean;
		save?: boolean;
	}): CanvasNode;
	getEdgesForNode(node: CanvasNode): CanvasEdge[];
	getViewportBBox(): CanvasBBox;
	getViewportNodes?(): CanvasNode[];
	selectOnly(element: CanvasElement): void;
	deselectAll(): void;
	updateSelection?(update: () => void): void;
	zoomToSelection?(): void;
	requestSave?(pushHistory?: boolean): void;
	overrideHistory?(): void;
	pushHistory?(data: CanvasData): void;
}

// Obsidian Canvas view. It is typed as TextFileView because Canvas has no stable public class.
export interface CanvasView extends TextFileView {
	canvas?: Canvas;
	file: TFile;
	scope: Scope | null;
}
