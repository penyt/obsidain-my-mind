//Adapter for Obsidian Canvas private runtime APIs

//------------ import dependencies ------------
import { App, TextFileView } from 'obsidian';
import {
	Canvas,
	CanvasEdge,
	CanvasEdgeData,
	CanvasNode,
	CanvasNodeSide,
	CanvasSize,
	CanvasView,
} from './canvas-types';

//------------ constants ------------
const DEFAULT_TEXT_NODE_SIZE: CanvasSize = {
	width: 250,
	height: 60,
};

/**
 * Tracks a temporary Canvas.requestSave() hook.
 * The hook must only restore requestSave if it is still our wrapper, because
 * another plugin may wrap or replace requestSave after us.
 */
//------------ requestSave hook handle ------------
export interface RequestSaveHookHandle {
	canvas: Canvas;
	originalRequestSave: NonNullable<Canvas['requestSave']>;
	wrappedRequestSave: NonNullable<Canvas['requestSave']>;
	detach(): void;
}

/**
 * Thin facade around Obsidian Canvas runtime internals.
 * Keeping private API access here makes the rest of the plugin easier to audit
 * when Obsidian changes Canvas implementation details.
 */
//------------ Canvas adapter service ------------
export class CanvasAdapter {
	private readonly pendingBatchChanges = new WeakSet<Canvas>();

	constructor(private readonly app: App) {}

	// Only use the active Canvas view; never fall back to background Canvas leaves.
	getCurrentCanvasView(): CanvasView | null {
		const activeView = this.app.workspace.getActiveViewOfType(TextFileView);
		if (!activeView || activeView.getViewType() !== 'canvas') return null;

		return activeView as CanvasView;
	}

	getCurrentCanvas(): Canvas | null {
		return this.getCurrentCanvasView()?.canvas ?? null;
	}

	getCanvasKey(canvas: Canvas): string | null {
		return canvas.view.file?.path ?? null;
	}

	/** Wrap Canvas.requestSave() while preserving this/args/return value. */
	hookRequestSave(canvas: Canvas, afterSave: () => void): RequestSaveHookHandle | null {
		const originalRequestSave: NonNullable<Canvas['requestSave']> | undefined = Reflect.get(canvas, 'requestSave');
		if (!originalRequestSave) return null;

		const wrappedRequestSave: NonNullable<Canvas['requestSave']> = function wrappedRequestSave(this: Canvas, ...args) {
			const result = originalRequestSave.apply(this, args);
			afterSave();
			return result;
		};

		canvas.requestSave = wrappedRequestSave;
		return {
			canvas,
			originalRequestSave,
			wrappedRequestSave,
			detach: () => {
				if (canvas.requestSave === wrappedRequestSave) canvas.requestSave = originalRequestSave;
			},
		};
	}

	// Return a node only for the single-selection workflows.
	getSelectedNode(canvas: Canvas): CanvasNode | null {
		if (canvas.selection.size !== 1) return null;

		const selected = canvas.selection.values().next().value;
		if (!selected) return null;
		if (!canvas.nodes.has(selected.id)) return null;

		return canvas.nodes.get(selected.id) ?? null;
	}

	getTextNodeSize(canvas: Canvas, referenceNode?: CanvasNode): CanvasSize {
		if (referenceNode) {
			return {
				width: referenceNode.width,
				height: referenceNode.height,
			};
		}

		return canvas.config?.defaultTextNodeDimensions ?? DEFAULT_TEXT_NODE_SIZE;
	}

	createTextNode(
		canvas: Canvas,
		x: number,
		y: number,
		size: CanvasSize,
	): CanvasNode {
		return canvas.createTextNode({
			pos: { x, y },
			size,
			text: '',
			focus: false,
			save: true,
		});
	}

	// Plugin-created edges are marked structural immediately.
	createEdge(
		canvas: Canvas,
		fromNode: CanvasNode,
		toNode: CanvasNode,
		fromSide: CanvasNodeSide = 'right',
		toSide: CanvasNodeSide = 'left',
	): CanvasEdgeData {
		const edge: CanvasEdgeData = {
			id: createId(),
			fromNode: fromNode.id,
			fromSide,
			toNode: toNode.id,
			toSide,
			myMindStructuralEdge: true,
		};

		canvas.importData({ nodes: [], edges: [edge] }, false, false);
		canvas.requestSave?.();
		return edge;
	}

	selectNode(canvas: Canvas, node: CanvasNode): void {
		canvas.selectOnly(node);
	}

	selectAndRevealNode(canvas: Canvas, node: CanvasNode, zoomToSelection: boolean): void {
		this.selectNode(canvas, node);
		if (zoomToSelection) canvas.zoomToSelection?.();
	}

	startEditing(node: CanvasNode): boolean {
		if (node.startEditing) {
			node.startEditing();
			return true;
		}

		if (node.setIsEditing) {
			node.setIsEditing(true);
			return true;
		}

		return false;
	}

	// Try every known focus/editing escape hatch because Canvas internals vary by version.
	stopEditing(node: CanvasNode): boolean {
		node.setIsEditing?.(false);
		node.blur?.();

		const iframe = node.nodeEl?.querySelector('iframe');
		const iframeActiveElement = iframe?.contentDocument?.activeElement;
		if (iframeActiveElement instanceof HTMLElement) iframeActiveElement.blur();
		if (iframe instanceof HTMLElement) iframe.blur();

		node.child?.editMode?.cm?.dom?.blur();
		node.contentEl?.blur();
		node.nodeEl?.focus();
		node.canvas.wrapperEl?.focus();
		node.focus?.();
		node.isEditing = false;
		return true;
	}

	getParents(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		const parent = this.getStructuralParent(canvas, node);
		return parent ? [parent] : [];
	}

	getChildren(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		return this.getStructuralChildren(canvas, node);
	}

	getStructuralParent(canvas: Canvas, node: CanvasNode): CanvasNode | null {
		const edge = this.getPrimaryIncomingEdge(canvas, node);
		return edge ? canvas.nodes.get(edge.getData().fromNode) ?? null : null;
	}

	// Children are filtered through their primary incoming edge so cross-links are ignored.
	getStructuralChildren(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		return Array.from(canvas.edges.values())
			.filter((edge) => edge.getData().fromNode === node.id)
			.filter((edge) => {
				const child = canvas.nodes.get(edge.getData().toNode);
				if (!child) return false;
				return this.getPrimaryIncomingEdge(canvas, child)?.getData().id === edge.getData().id;
			})
			.map((edge) => canvas.nodes.get(edge.getData().toNode))
			.filter((child): child is CanvasNode => child !== undefined);
	}

	/**
	 * Resolve the one structural parent edge for a node.
	 * Persisted myMindStructuralEdge wins; deterministic fallback is only used for
	 * old Canvas files that do not yet have structural markers.
	 */
	getPrimaryIncomingEdge(canvas: Canvas, node: CanvasNode, persistFallback = false): CanvasEdge | null {
		const incomingEdges = this.getValidIncomingEdges(canvas, node);
		if (incomingEdges.length === 0) return null;

		const structuralEdges = incomingEdges.filter((edge) => edge.getData().myMindStructuralEdge === true);
		const primaryEdge = structuralEdges.length > 0
			? this.sortIncomingEdges(canvas, structuralEdges)[0] ?? null
			: this.sortIncomingEdges(canvas, incomingEdges)[0] ?? null;
		if (primaryEdge && (persistFallback || structuralEdges.length > 1)) {
			this.setStructuralIncomingEdgeWithoutSave(canvas, primaryEdge);
		}
		return primaryEdge;
	}


	/**
	 * Mark exactly one incoming edge as structural for the child.
	 * Other incoming edges are kept visible but become cross-links for tree logic.
	 */
	setStructuralIncomingEdgeWithoutSave(canvas: Canvas, primaryEdge: CanvasEdge): boolean {
		const childId = primaryEdge.getData().toNode;
		let changed = false;
		const primaryEdgeId = primaryEdge.getData().id;
		for (const edge of this.getValidIncomingEdgesByChildId(canvas, childId)) {
			const data = edge.getData();
			const shouldBeStructural = data.id === primaryEdgeId;
			if ((data.myMindStructuralEdge === true) === shouldBeStructural) continue;

			if (shouldBeStructural) {
				edge.setData({ ...data, myMindStructuralEdge: true }, false);
			} else {
				const nextData = { ...data };
				delete nextData.myMindStructuralEdge;
				edge.setData(nextData, false);
			}
			changed = true;
		}
		if (changed) this.pendingBatchChanges.add(canvas);
		return changed;
	}

	private getValidIncomingEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
		return this.getValidIncomingEdgesByChildId(canvas, node.id);
	}

	private getValidIncomingEdgesByChildId(canvas: Canvas, childId: string): CanvasEdge[] {
		return Array.from(canvas.edges.values()).filter((edge) => {
			const data = edge.getData();
			return data.toNode === childId && canvas.nodes.has(data.fromNode) && canvas.nodes.has(data.toNode);
		});
	}

	// Deterministic fallback order for old files without structural markers.
	private sortIncomingEdges(canvas: Canvas, edges: CanvasEdge[]): CanvasEdge[] {
		return [...edges].sort((a, b) => {
			const parentA = canvas.nodes.get(a.getData().fromNode);
			const parentB = canvas.nodes.get(b.getData().fromNode);
			if (!parentA || !parentB) return parentA ? -1 : parentB ? 1 : 0;

			const childId = a.getData().toNode;
			const depthA = this.getIncomingDepthHint(canvas, parentA, new Set([childId]));
			const depthB = this.getIncomingDepthHint(canvas, parentB, new Set([childId]));
			return depthB - depthA || compareNodesByPosition(parentA, parentB);
		});
	}

	private getIncomingDepthHint(canvas: Canvas, node: CanvasNode, visitedNodeIds: Set<string>): number {
		if (visitedNodeIds.has(node.id)) return 0;
		visitedNodeIds.add(node.id);

		let depth = 0;
		for (const edge of canvas.edges.values()) {
			const data = edge.getData();
			if (data.toNode !== node.id) continue;

			const parent = canvas.nodes.get(data.fromNode);
			if (!parent) continue;
			depth = Math.max(depth, this.getIncomingDepthHint(canvas, parent, new Set(visitedNodeIds)) + 1);
		}
		return depth;
	}


	// Move node data without pushing history; caller commits the batch later.
	setNodePositionWithoutSave(node: CanvasNode, x: number, y: number): boolean {
		if (Math.abs(node.x - x) < 1 && Math.abs(node.y - y) < 1) return false;

		node.setData({
			...node.getData(),
			x,
			y,
		}, false);
		node.render?.();
		return true;
	}


	/** Mark a user-positioned node so future automatic layout preserves it. */
	markNodeManualPositionWithoutSave(node: CanvasNode): boolean {
		const data = node.getData();
		if (data.myMindManualPosition === true && data.x === node.x && data.y === node.y) return false;

		node.setData({
			...data,
			x: node.x,
			y: node.y,
			width: node.width,
			height: node.height,
			myMindManualPosition: true,
		}, false);
		return true;
	}


	// Clear manual-position marker without deleting or moving the node.
	clearNodeManualPositionWithoutSave(node: CanvasNode): boolean {
		const data = node.getData();
		if (data.myMindManualPosition !== true) return false;

		const nextData = { ...data };
		delete nextData.myMindManualPosition;
		node.setData(nextData, false);
		return true;
	}

	// Store auto-color marker so future manual colors can be detected.
	setNodeAutoColor(canvas: Canvas, node: CanvasNode, color: string): void {
		node.setData({
			...node.getData(),
			color,
			myMindAutoColor: color,
		}, true);
		canvas.requestSave?.();
	}

	setEdgeAutoColor(canvas: Canvas, edge: CanvasEdge, color: string): void {
		edge.setData({
			...edge.getData(),
			color,
			myMindAutoColor: color,
		}, true);
		canvas.requestSave?.();
	}

	// Edge side changes are batched with layout so undo stays compact.
	setEdgeSidesWithoutSave(edge: CanvasEdge, fromSide: CanvasNodeSide, toSide: CanvasNodeSide): boolean {
		const data = edge.getData();
		if (data.fromSide === fromSide && data.toSide === toSide) return false;

		edge.setData({
			...data,
			fromSide,
			toSide,
		}, false);
		return true;
	}

	/**
	 * Commit a plugin-owned batch as a single Canvas history entry.
	 * Methods ending in WithoutSave rely on this to avoid one undo step per node.
	 */
	commitCanvasBatch(canvas: Canvas, changed: boolean, historyMode: 'push' | 'replace' = 'push'): boolean {
		const hasPendingChange = this.pendingBatchChanges.delete(canvas);
		if (!changed && !hasPendingChange) return false;
		if (historyMode === 'replace') {
			canvas.requestSave?.(false);
			this.replaceHistory(canvas);
			return true;
		}

		canvas.requestSave?.();
		this.pushHistory(canvas);
		return true;
	}

	replaceHistory(canvas: Canvas): void {
		if (canvas.overrideHistory) {
			canvas.overrideHistory();
			return;
		}
		this.pushHistory(canvas);
	}

	pushHistory(canvas: Canvas): void {
		canvas.pushHistory?.(canvas.getData());
	}
}

//------------ utility functions ------------
function compareNodesByPosition(a: CanvasNode, b: CanvasNode): number {
	return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

// Prefer browser UUIDs; fallback keeps generated IDs stable enough for local Canvas data.
function createId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}

	return `my-mind-${Date.now().toString(36)}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
}
