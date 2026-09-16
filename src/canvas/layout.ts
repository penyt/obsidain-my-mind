//Structural tree layout for Canvas mindmaps

//------------ import dependencies ------------
import { CanvasAdapter } from './canvas-adapter';
import { Canvas, CanvasBBox, CanvasEdge, CanvasNode, CanvasNodeSide } from './canvas-types';

//------------ public layout types ------------
export interface MindmapLayoutOptions {
	rowGap: number;
	columnGap: number;
	rootBranchDirections: boolean;
}

export type LayoutDirection = 'left' | 'right';

// Internal tree node used only while computing layout.
interface TreeLayoutNode {
	node: CanvasNode;
	children: TreeLayoutNode[];
	subtreeHeight: number;
	direction: LayoutDirection;
	incomingEdge?: CanvasEdge;
	isRoot: boolean;
}

/**
 * Computes deterministic tree positions from structural Canvas edges.
 * Cross-links remain in Canvas but are ignored for parent/child traversal.
 */
//------------ layout service ------------
export class MindmapLayout {
	constructor(
		private readonly adapter: CanvasAdapter,
		private readonly options: MindmapLayoutOptions,
	) {}

	/** Full auto layout for all structural root trees in the current Canvas. */
	layoutForest(canvas: Canvas, historyMode: 'push' | 'replace' = 'push'): boolean {
		const assignedNodeIds = new Set<string>();
		const roots = this.getLayoutRoots(canvas)
			.map((root) => this.buildTree(canvas, root, assignedNodeIds, new Set()))
			.filter((tree): tree is TreeLayoutNode => tree !== null && tree.children.length > 0);
		if (roots.length === 0) return false;

		for (const root of roots) {
			this.computeSubtreeHeight(root);
		}

		const positions = new Map<string, { x: number; y: number }>();
		const edgeSides = new Map<string, { edge: CanvasEdge; fromSide: CanvasNodeSide; toSide: CanvasNodeSide }>();
		for (const root of roots) {
			this.assignTreePositions(root, root.node.x, root.node.y + root.node.height / 2, positions, edgeSides);
		}

		let changed = this.applyEdgeSides(edgeSides);
		for (const [id, position] of positions) {
			const node = canvas.nodes.get(id);
			if (!node) continue;
			if (Math.abs(node.x - position.x) < 1 && Math.abs(node.y - position.y) < 1) continue;

			this.adapter.setNodePositionWithoutSave(node, position.x, position.y);
			changed = true;
		}

		this.saveLayoutBatch(canvas, changed, historyMode);
		return changed;
	}

	// Relayout the structural tree that contains the given node.
	layoutTreeContaining(canvas: Canvas, node: CanvasNode): boolean {
		const root = this.getLayoutRootForNode(canvas, node);
		if (!root) return false;

		return this.layoutTreeFromRoot(canvas, root, true);
	}


	// Estimate where a newly-created child should appear before full relayout.
	getNextChildPosition(canvas: Canvas, parent: CanvasNode, childWidth?: number): { x: number; y: number } {
		const children = this.getLayoutChildren(canvas, parent);
		const direction = this.getBranchDirection(canvas, parent);
		const x = this.getChildX(parent, childWidth ?? this.adapter.getTextNodeSize(canvas, parent).width, direction);

		if (children.length === 0) {
			return { x, y: parent.y };
		}

		const sortedChildren = [...children].sort((a, b) => a.y - b.y);
		const lastChild = sortedChildren[sortedChildren.length - 1];
		if (!lastChild) return { x, y: parent.y };

		const lastSubtreeBBox = this.getNodesBBox(this.getSubtreeNodes(canvas, lastChild));
		return {
			x,
			y: lastSubtreeBBox.maxY + this.options.rowGap,
		};
	}

	getNextSiblingPosition(canvas: Canvas, node: CanvasNode): { x: number; y: number } {
		const subtreeBBox = this.getNodesBBox(this.getSubtreeNodes(canvas, node));
		return {
			x: node.x,
			y: subtreeBBox.maxY + this.options.rowGap,
		};
	}

	getStructuralChildren(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		return this.getLayoutChildren(canvas, node);
	}

	getStructuralParent(canvas: Canvas, node: CanvasNode): CanvasNode | null {
		return this.getPrimaryLayoutParent(canvas, node);
	}

	// Descendants inherit left/right direction from their first-level root edge.
	getBranchDirection(canvas: Canvas, node: CanvasNode): LayoutDirection {
		if (!this.options.rootBranchDirections) return 'right';

		let current = node;
		const visited = new Set<string>();

		while (!visited.has(current.id)) {
			visited.add(current.id);
			const incomingEdge = this.getPrimaryIncomingEdge(canvas, current);
			if (!incomingEdge) return 'right';

			const parent = canvas.nodes.get(incomingEdge.getData().fromNode);
			if (!parent) return 'right';
			if (!this.getPrimaryIncomingEdge(canvas, parent)) {
				return incomingEdge.getData().fromSide === 'left' ? 'left' : 'right';
			}
			current = parent;
		}

		return 'right';
	}

	// Root-level siblings are placed below existing root nodes.
	getNextRootSiblingPosition(canvas: Canvas, node: CanvasNode): { x: number; y: number } {
		const rootNodes = Array.from(canvas.nodes.values()).filter(
			(candidate) => this.adapter.getParents(canvas, candidate).length === 0,
		);
		const sortedRootNodes = [...rootNodes].sort((a, b) => a.y - b.y);
		const lastRoot = sortedRootNodes[sortedRootNodes.length - 1];

		return {
			x: node.x,
			y: lastRoot ? lastRoot.y + lastRoot.height + this.options.rowGap : node.y + node.height + this.options.rowGap,
		};
	}

	// Layout one root tree while preserving the root node position.
	private layoutTreeFromRoot(canvas: Canvas, root: CanvasNode, pushHistory: boolean): boolean {
		const tree = this.buildTree(canvas, root, new Set(), new Set());
		if (!tree || tree.children.length === 0) return false;

		this.computeSubtreeHeight(tree);
		const positions = new Map<string, { x: number; y: number }>();
		const edgeSides = new Map<string, { edge: CanvasEdge; fromSide: CanvasNodeSide; toSide: CanvasNodeSide }>();
		this.assignTreePositions(tree, root.x, root.y + root.height / 2, positions, edgeSides);

		let changed = this.applyEdgeSides(edgeSides);
		for (const [id, position] of positions) {
			const node = canvas.nodes.get(id);
			if (!node) continue;
			if (Math.abs(node.x - position.x) < 1 && Math.abs(node.y - position.y) < 1) continue;

			this.adapter.setNodePositionWithoutSave(node, position.x, position.y);
			changed = true;
		}

		if (pushHistory) {
			this.saveLayoutBatch(canvas, changed, 'push');
		} else {
			this.saveLayoutBatch(canvas, changed, 'replace');
		}
		return changed;
	}

	private saveLayoutBatch(canvas: Canvas, changed: boolean, historyMode: 'push' | 'replace'): void {
		this.adapter.commitCanvasBatch(canvas, changed, historyMode);
	}

	// Walk up structural parents until a layout root is found.
	private getLayoutRootForNode(canvas: Canvas, node: CanvasNode): CanvasNode | null {
		let current = node;
		const visited = new Set<string>();

		while (!visited.has(current.id)) {
			visited.add(current.id);
			const parent = this.getPrimaryLayoutParent(canvas, current);
			if (!parent) return this.getLayoutChildren(canvas, current).length > 0 ? current : null;
			current = parent;
		}

		return null;
	}

	private getPrimaryLayoutParent(canvas: Canvas, node: CanvasNode): CanvasNode | null {
		const edge = this.getPrimaryIncomingEdge(canvas, node);
		return edge ? canvas.nodes.get(edge.getData().fromNode) ?? null : null;
	}

	private getPrimaryIncomingEdge(canvas: Canvas, node: CanvasNode): CanvasEdge | null {
		return this.adapter.getPrimaryIncomingEdge(canvas, node, true);
	}

	private getLayoutRoots(canvas: Canvas): CanvasNode[] {
		return Array.from(canvas.nodes.values())
			.filter((node) => this.getPrimaryIncomingEdge(canvas, node) === null)
			.filter((node) => this.getLayoutChildren(canvas, node).length > 0)
			.sort(compareNodesByPosition);
	}

	/** Build a cycle-safe tree where each Canvas node appears at most once. */
	private buildTree(
		canvas: Canvas,
		node: CanvasNode,
		assignedNodeIds: Set<string>,
		pathNodeIds: Set<string>,
		direction: LayoutDirection = 'right',
		incomingEdge?: CanvasEdge,
	): TreeLayoutNode | null {
		if (assignedNodeIds.has(node.id) || pathNodeIds.has(node.id)) return null;

		assignedNodeIds.add(node.id);
		pathNodeIds.add(node.id);
		const isRoot = this.getPrimaryIncomingEdge(canvas, node) === null;
		const children = this.getLayoutChildEdges(canvas, node)
			.map((edge) => {
				const edgeData = edge.getData();
				const child = canvas.nodes.get(edgeData.toNode);
				if (!child) return null;
				const childDirection = this.options.rootBranchDirections && isRoot && edgeData.fromSide === 'left' ? 'left' : direction;
				return this.buildTree(canvas, child, assignedNodeIds, pathNodeIds, childDirection, edge);
			})
			.filter((child): child is TreeLayoutNode => child !== null);
		pathNodeIds.delete(node.id);

		return {
			node,
			children,
			subtreeHeight: node.height,
			direction,
			incomingEdge,
			isRoot,
		};
	}

	private getLayoutChildren(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		return this.getLayoutChildEdges(canvas, node)
			.map((edge) => canvas.nodes.get(edge.getData().toNode))
			.filter((child): child is CanvasNode => child !== undefined);
	}

	/** Only structural outgoing edges participate in layout traversal. */
	private getLayoutChildEdges(canvas: Canvas, node: CanvasNode): CanvasEdge[] {
		return Array.from(canvas.edges.values())
			.filter((edge) => edge.getData().fromNode === node.id)
			.filter((edge) => {
				const child = canvas.nodes.get(edge.getData().toNode);
				if (!child) return false;
				return this.getPrimaryIncomingEdge(canvas, child)?.getData().id === edge.getData().id;
			})
			.sort((a, b) => {
				const childA = canvas.nodes.get(a.getData().toNode);
				const childB = canvas.nodes.get(b.getData().toNode);
				if (!childA || !childB) return childA ? -1 : childB ? 1 : 0;
				return compareNodesByPosition(childA, childB);
			});
	}

	// Compute vertical space needed before assigning positions.
	private computeSubtreeHeight(tree: TreeLayoutNode): number {
		if (tree.children.length === 0) {
			tree.subtreeHeight = tree.node.height;
			return tree.subtreeHeight;
		}

		for (const child of tree.children) {
			this.computeSubtreeHeight(child);
		}
		const childrenHeight = tree.isRoot
			? Math.max(
				this.getChildrenGroupHeight(tree.children.filter((child) => child.direction === 'left')),
				this.getChildrenGroupHeight(tree.children.filter((child) => child.direction === 'right')),
			)
			: this.getChildrenGroupHeight(tree.children);
		tree.subtreeHeight = Math.max(tree.node.height, childrenHeight);
		return tree.subtreeHeight;
	}

	/** Assign positions while preserving the root anchor passed by the caller. */
	private assignTreePositions(
		tree: TreeLayoutNode,
		x: number,
		centerY: number,
		positions: Map<string, { x: number; y: number }>,
		edgeSides: Map<string, { edge: CanvasEdge; fromSide: CanvasNodeSide; toSide: CanvasNodeSide }>,
	): void {
		positions.set(tree.node.id, {
			x,
			y: centerY - tree.node.height / 2,
		});

		if (tree.incomingEdge) {
			edgeSides.set(tree.incomingEdge.getData().id, {
				edge: tree.incomingEdge,
				fromSide: tree.direction,
				toSide: getOppositeSide(tree.direction),
			});
		}
		if (tree.children.length === 0) return;

		if (tree.isRoot) {
			this.assignChildGroup(tree, x, tree.children.filter((child) => child.direction === 'left'), centerY, positions, edgeSides, 'left');
			this.assignChildGroup(tree, x, tree.children.filter((child) => child.direction === 'right'), centerY, positions, edgeSides, 'right');
			return;
		}

		this.assignChildGroup(tree, x, tree.children, centerY, positions, edgeSides, tree.direction);
	}

	// Place a left or right group around the parent center line.
	private assignChildGroup(
		parent: TreeLayoutNode,
		parentX: number,
		children: TreeLayoutNode[],
		centerY: number,
		positions: Map<string, { x: number; y: number }>,
		edgeSides: Map<string, { edge: CanvasEdge; fromSide: CanvasNodeSide; toSide: CanvasNodeSide }>,
		direction: LayoutDirection,
	): void {
		if (children.length === 0) return;

		const childrenHeight = children.reduce((sum, child, index) => {
			const previous = children[index - 1];
			const gap = previous ? this.getSiblingGap(previous, child) : 0;
			return sum + child.subtreeHeight + gap;
		}, 0);
		let nextTop = centerY - childrenHeight / 2;

		for (const [index, child] of children.entries()) {
			const childCenterY = nextTop + child.subtreeHeight / 2;
			this.assignTreePositions(child, this.getChildXFromPosition(parentX, parent.node.width, child.node.width, direction), childCenterY, positions, edgeSides);
			const nextChild = children[index + 1];
			if (nextChild) nextTop += child.subtreeHeight + this.getSiblingGap(child, nextChild);
		}
	}

	private getChildrenGroupHeight(children: TreeLayoutNode[]): number {
		return children.reduce((sum, child, index) => {
			const previous = children[index - 1];
			const gap = previous ? this.getSiblingGap(previous, child) : 0;
			return sum + child.subtreeHeight + gap;
		}, 0);
	}

	// Leaf siblings stay tighter; subtree siblings get extra branch spacing.
	private getSiblingGap(previous: TreeLayoutNode, next: TreeLayoutNode): number {
		return previous.children.length === 0 && next.children.length === 0
			? this.options.rowGap
			: this.getBranchGap();
	}


	private getBranchGap(): number {
		return this.options.rowGap * 1.5;
	}

	private getChildX(parent: CanvasNode, childWidth: number, direction: LayoutDirection): number {
		return this.getChildXFromPosition(parent.x, parent.width, childWidth, direction);
	}

	private getChildXFromPosition(parentX: number, parentWidth: number, childWidth: number, direction: LayoutDirection): number {
		return direction === 'left'
			? parentX - this.options.columnGap - childWidth
			: parentX + parentWidth + this.options.columnGap;
	}

	// Keep Canvas edge sides aligned with computed branch direction.
	private applyEdgeSides(edgeSides: Map<string, { edge: CanvasEdge; fromSide: CanvasNodeSide; toSide: CanvasNodeSide }>): boolean {
		let changed = false;
		for (const { edge, fromSide, toSide } of edgeSides.values()) {
			const edgeData = edge.getData();
			if (edgeData.fromSide === fromSide && edgeData.toSide === toSide) continue;

			this.adapter.setEdgeSidesWithoutSave(edge, fromSide, toSide);
			changed = true;
		}
		return changed;
	}

	// Return all structural descendants for incremental subtree movement.
	private getSubtreeNodes(canvas: Canvas, root: CanvasNode): CanvasNode[] {
		const nodes: CanvasNode[] = [];
		const visited = new Set<string>();
		const queue = [root];

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || visited.has(current.id)) continue;

			visited.add(current.id);
			nodes.push(current);

			for (const child of this.getLayoutChildren(canvas, current)) {
				if (!visited.has(child.id)) queue.push(child);
			}
		}

		return nodes;
	}

	private getNodesBBox(nodes: CanvasNode[]): CanvasBBox {
		return nodes.reduce(
			(bbox, node) => ({
				minX: Math.min(bbox.minX, node.x),
				maxX: Math.max(bbox.maxX, node.x + node.width),
				minY: Math.min(bbox.minY, node.y),
				maxY: Math.max(bbox.maxY, node.y + node.height),
			}),
			{
				minX: Infinity,
				maxX: -Infinity,
				minY: Infinity,
				maxY: -Infinity,
			},
		);
	}

}

//------------ utility functions ------------
function getOppositeSide(direction: LayoutDirection): CanvasNodeSide {
	return direction === 'left' ? 'right' : 'left';
}

function compareNodesByPosition(a: CanvasNode, b: CanvasNode): number {
	return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}
