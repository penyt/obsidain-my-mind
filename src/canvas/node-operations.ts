//Canvas node creation, coloring, and layout operations

//------------ import dependencies ------------
import { MyMindSettings } from '../settings';
import { CanvasAdapter } from './canvas-adapter';
import { MindmapLayout } from './layout';
import { Canvas, CanvasEdge, CanvasNode, CanvasNodeSide, CanvasSize } from './canvas-types';

//------------ constants ------------
const FALLBACK_FIRST_LEVEL_COLORS = ['1', '2', '3', '4', '5', '6'];

// Scheduler is injected so delayed work is still owned by the controller lifecycle.
export interface NodeOperationsScheduler {
	scheduleTimeout(callback: () => void, delay: number, canvas: Canvas): void;
}

/** High-level Canvas node operations: creation, coloring, and layout triggers. */
//------------ node operation service ------------
export class NodeOperations {
	constructor(
		private readonly adapter: CanvasAdapter,
		private readonly layout: MindmapLayout,
		private readonly settings: MyMindSettings,
		private readonly scheduler: NodeOperationsScheduler,
	) {}

	// Create a text node as structural child of the selected parent node.
	createChild(canvas: Canvas, parent: CanvasNode): CanvasNode {
		const size = this.getNewNodeSize();
		const existingChildren = this.layout.getStructuralChildren(canvas, parent);
		const direction = this.layout.getBranchDirection(canvas, parent);
		const position = this.layout.getNextChildPosition(canvas, parent, size.width);
		const child = this.adapter.createTextNode(canvas, position.x, position.y, size);
		const edge = this.adapter.createEdge(canvas, parent, child, direction, getOppositeSide(direction));

		this.colorNewNode(canvas, parent, child, edge.id);
		this.layoutChildrenIfAllowed(canvas, parent, [...existingChildren, child]);
		this.afterCreate(canvas, child);

		return child;
	}

	// Create a sibling. Root nodes get no edge; non-root siblings share the parent.
	createSibling(canvas: Canvas, node: CanvasNode): CanvasNode {
		const parent = this.adapter.getParents(canvas, node)[0];
		const size = this.getNewNodeSize();
		let sibling: CanvasNode;

		if (!parent) {
			const position = this.layout.getNextRootSiblingPosition(canvas, node);
			sibling = this.adapter.createTextNode(canvas, position.x, position.y, size);
		} else {
			const existingSiblings = this.layout.getStructuralChildren(canvas, parent);
			const direction = this.layout.getBranchDirection(canvas, node);
			const position = this.layout.getNextSiblingPosition(canvas, node);
			sibling = this.adapter.createTextNode(canvas, position.x, position.y, size);
			const edge = this.adapter.createEdge(canvas, parent, sibling, direction, getOppositeSide(direction));

			this.colorNewNode(canvas, parent, sibling, edge.id);
			this.layoutChildrenIfAllowed(canvas, parent, [...existingSiblings, sibling]);
		}

		this.afterCreate(canvas, sibling);
		return sibling;
	}

	// Run full forest layout for the current Canvas.
	autoLayout(canvas: Canvas, historyMode: 'push' | 'replace' = 'push'): boolean {
		return this.layout.layoutForest(canvas, historyMode);
	}

	autoLayoutAround(canvas: Canvas, node: CanvasNode): boolean {
		const parent = this.layout.getStructuralParent(canvas, node) ?? node;
		const children = this.layout.getStructuralChildren(canvas, parent);
		if (children.length === 0) return false;
		this.layoutChildrenIfAllowed(canvas, parent, children);
		return true;
	}

	relayoutTreeContaining(canvas: Canvas, node: CanvasNode): boolean {
		return this.layout.layoutTreeContaining(canvas, node);
	}

	// Re-apply configured first-level branch colors without changing manual colors.
	applyFirstLevelColors(canvas: Canvas): void {
		for (const node of canvas.nodes.values()) {
			if (this.adapter.getParents(canvas, node).length > 0) continue;
			this.colorFirstLevelBranches(canvas, node, this.adapter.getChildren(canvas, node));
		}
	}

	/** Apply branch color immediately, then once more after Canvas finishes rendering the new edge. */
	private colorNewNode(canvas: Canvas, parent: CanvasNode, node: CanvasNode, edgeId: string): void {
		if (!this.settings.autoColorFirstLevel) return;

		if (this.isRoot(canvas, parent)) {
			const color = this.getNextFirstLevelBranchColor(canvas, parent, node);
			this.colorNodeAndIncomingEdge(canvas, node, edgeId, color);
			this.scheduler.scheduleTimeout(() => {
				if (!canvas.nodes.has(node.id)) return;
				this.colorNodeAndIncomingEdge(canvas, node, edgeId, color);
			}, 100, canvas);
			return;
		}

		const color = parent.getData().color ?? this.findBranchColor(canvas, parent);
		if (!color) return;

		this.colorNodeAndIncomingEdge(canvas, node, edgeId, color);
		this.scheduler.scheduleTimeout(() => {
			if (!canvas.nodes.has(node.id)) return;
			this.colorNodeAndIncomingEdge(canvas, node, edgeId, color);
		}, 100, canvas);
	}

	// Pick the next palette color after existing first-level branch colors.
	private getNextFirstLevelBranchColor(canvas: Canvas, parent: CanvasNode, newNode: CanvasNode): string {
		const colors = this.settings.firstLevelColors.length > 0
			? this.settings.firstLevelColors
			: FALLBACK_FIRST_LEVEL_COLORS;
		const existingColors = this.adapter
			.getChildren(canvas, parent)
			.filter((child) => child.id !== newNode.id)
			.map((child) => getManualColor(child.getData()) ?? getAutoColor(child.getData()) ?? child.getData().color)
			.filter((color): color is string => typeof color === 'string');
		const existingIndexes = existingColors
			.map((color) => colors.indexOf(color))
			.filter((index) => index >= 0);

		if (existingIndexes.length === 0) {
			return colors[0] ?? '1';
		}

		const maxIndex = Math.max(...existingIndexes);
		return colors[(maxIndex + 1) % colors.length] ?? '1';
	}

	private colorFirstLevelBranches(canvas: Canvas, parent: CanvasNode, children: CanvasNode[]): void {
		if (!this.settings.autoColorFirstLevel) return;
		if (!this.isRoot(canvas, parent)) return;

		const colors = this.settings.firstLevelColors.length > 0
			? this.settings.firstLevelColors
			: FALLBACK_FIRST_LEVEL_COLORS;
		const orderedChildren = [...children].sort((a, b) => a.y - b.y);

		orderedChildren.forEach((child, index) => {
			const paletteColor = colors[index % colors.length] ?? '1';
			const color = getManualColor(child.getData()) ?? paletteColor;
			this.colorBranch(canvas, child, color, new Set());
		});
	}

	// Color a branch recursively, using visited ids to avoid cycles.
	private colorBranch(canvas: Canvas, root: CanvasNode, color: string, visitedNodeIds: Set<string>): void {
		if (visitedNodeIds.has(root.id)) return;
		visitedNodeIds.add(root.id);

		const nodeData = root.getData();
		const effectiveColor = getManualColor(nodeData) ?? color;
		if (canApplyAutoColor(nodeData) && nodeData.color !== effectiveColor) {
			this.adapter.setNodeAutoColor(canvas, root, effectiveColor);
		}

		for (const edge of canvas.edges.values()) {
			const edgeData = edge.getData();
			if (edgeData.fromNode !== root.id) continue;

			const child = canvas.nodes.get(edgeData.toNode);
			if (!child) continue;

			this.colorEdge(canvas, edge, effectiveColor);
			this.colorBranch(canvas, child, effectiveColor, visitedNodeIds);
		}
	}

	private colorNodeAndIncomingEdge(canvas: Canvas, node: CanvasNode, edgeId: string, color: string): void {
		const nodeData = node.getData();
		const effectiveColor = getManualColor(nodeData) ?? color;
		if (canApplyAutoColor(nodeData) && nodeData.color !== effectiveColor) {
			this.adapter.setNodeAutoColor(canvas, node, effectiveColor);
		}

		const edge = this.getEdgeById(canvas, edgeId);
		if (edge) this.colorEdge(canvas, edge, effectiveColor);
	}

	private colorEdge(canvas: Canvas, edge: CanvasEdge, color: string): void {
		const edgeData = edge.getData();
		if (!canApplyAutoColor(edgeData) || edgeData.color === color) return;
		this.adapter.setEdgeAutoColor(canvas, edge, color);
	}

	private getEdgeById(canvas: Canvas, edgeId: string): CanvasEdge | null {
		return canvas.edges.get(edgeId) ??
			Array.from(canvas.edges.values()).find((edge) => edge.getData().id === edgeId) ??
			null;
	}

	private findBranchColor(canvas: Canvas, node: CanvasNode): string | null {
		let current: CanvasNode = node;

		while (true) {
			const parent = this.adapter.getParents(canvas, current)[0];
			if (!parent) return current.getData().color ?? null;
			if (this.isRoot(canvas, parent)) return current.getData().color ?? null;
			current = parent;
		}
	}

	private isRoot(canvas: Canvas, node: CanvasNode): boolean {
		return this.adapter.getParents(canvas, node).length === 0;
	}

	/** Skip automatic sibling layout when user-positioned subtrees are involved. */
	private layoutChildrenIfAllowed(canvas: Canvas, parent: CanvasNode, children: CanvasNode[]): void {
		if (!this.settings.autoLayoutSiblings) return;
		if (parent.getData().myMindManualPosition === true) return;
		if (this.hasManualPositionInSubtrees(canvas, children)) return;

		this.layout.layoutTreeContaining(canvas, parent);
	}

	private hasManualPositionInSubtrees(canvas: Canvas, roots: CanvasNode[]): boolean {
		const visited = new Set<string>();
		const queue = [...roots];

		while (queue.length > 0) {
			const node = queue.shift();
			if (!node || visited.has(node.id)) continue;
			visited.add(node.id);

			if (node.getData().myMindManualPosition === true) return true;
			queue.push(...this.layout.getStructuralChildren(canvas, node));
		}

		return false;
	}

	// Common post-create flow: select/reveal, optionally edit, then push history.
	private afterCreate(canvas: Canvas, node: CanvasNode): void {
		this.adapter.selectAndRevealNode(canvas, node, this.settings.zoomToNewNode);
		if (this.settings.autoEditNewNodes) {
			this.scheduler.scheduleTimeout(() => {
				if (canvas.readonly || !canvas.nodes.has(node.id)) return;
				this.adapter.startEditing(node);
			}, this.settings.editDelayMs, canvas);
		}
		this.adapter.pushHistory(canvas);
	}

	private getNewNodeSize(): CanvasSize {
		return {
			width: this.settings.newNodeWidth,
			height: this.settings.newNodeHeight,
		};
	}
}

//------------ utility functions ------------
function getOppositeSide(direction: CanvasNodeSide): CanvasNodeSide {
	return direction === 'left' ? 'right' : 'left';
}

// Auto color is safe only when there is no manual color override.
function canApplyAutoColor(data: { color?: string; [key: string]: unknown }): boolean {
	const autoColor = getAutoColor(data);
	return data.color === undefined || data.color === autoColor;
}

// Manual color means color differs from the stored myMindAutoColor marker.
function getManualColor(data: { color?: string; [key: string]: unknown }): string | null {
	if (!data.color) return null;
	const autoColor = getAutoColor(data);
	return data.color !== autoColor ? data.color : null;
}

function getAutoColor(data: { [key: string]: unknown }): string | null {
	return typeof data.myMindAutoColor === 'string' ? data.myMindAutoColor : null;
}
