//Arrow-key navigation for mindmap mode

//------------ import dependencies ------------
import { CanvasAdapter } from './canvas-adapter';
import { Canvas, CanvasNode } from './canvas-types';

//------------ public types ------------
export type NavigationDirection = 'up' | 'down' | 'left' | 'right';

/** Tree-aware navigation with geometry fallback when no structural target exists. */
//------------ navigation service ------------
export class MindmapNavigation {
	constructor(private readonly adapter: CanvasAdapter) {}

	// Prefer structural mindmap navigation, then fall back to visual geometry.
	getNextNode(canvas: Canvas, node: CanvasNode, direction: NavigationDirection): CanvasNode | null {
		return this.getTreeNode(canvas, node, direction) ?? this.getGeometryNode(canvas, node, direction);
	}

	// Navigate through parent/child/sibling relationships when possible.
	private getTreeNode(canvas: Canvas, node: CanvasNode, direction: NavigationDirection): CanvasNode | null {
		if (direction === 'left' || direction === 'right') {
			return this.getHorizontalTreeNode(canvas, node, direction);
		}

		const parent = this.adapter.getParents(canvas, node)[0];
		const siblings = parent
			? this.adapter.getChildren(canvas, parent)
			: Array.from(canvas.nodes.values()).filter(
					(candidate) => this.adapter.getParents(canvas, candidate).length === 0,
				);
		const ordered = [...siblings].sort((a, b) => a.y - b.y);
		const index = ordered.findIndex((candidate) => candidate.id === node.id);
		if (index === -1) return null;

		return direction === 'up'
			? ordered[index - 1] ?? null
			: ordered[index + 1] ?? null;
	}

	private getHorizontalTreeNode(canvas: Canvas, node: CanvasNode, direction: 'left' | 'right'): CanvasNode | null {
		const parent = this.adapter.getParents(canvas, node)[0];
		if (!parent) {
			return this.getChildrenInDirection(canvas, node, direction)[0] ?? null;
		}

		const branchDirection = getBranchDirection(canvas, node, this.adapter);
		if (direction !== branchDirection) return parent;
		return this.getChildrenInDirection(canvas, node, branchDirection)[0] ?? null;
	}

	private getChildrenInDirection(canvas: Canvas, node: CanvasNode, direction: 'left' | 'right'): CanvasNode[] {
		const isRoot = this.adapter.getParents(canvas, node).length === 0;
		return this.adapter.getChildren(canvas, node)
			.filter((child) => !isRoot || getIncomingEdgeFromSide(canvas, child, this.adapter) === direction)
			.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
	}

	// Fallback for unstructured nodes or cross-link-heavy Canvas files.
	private getGeometryNode(canvas: Canvas, node: CanvasNode, direction: NavigationDirection): CanvasNode | null {
		const source = node.getBBox();
		const candidates = Array.from(canvas.nodes.values()).filter(
			(candidate) => candidate.id !== node.id,
		);

		let best: { node: CanvasNode; distance: number; centerDistance: number } | null = null;

		for (const candidate of candidates) {
			const target = candidate.getBBox();
			const verticalOverlap = source.minY <= target.maxY && source.maxY >= target.minY;
			const horizontalOverlap = source.minX <= target.maxX && source.maxX >= target.minX;

			let distance = -1;
			if (direction === 'up' && horizontalOverlap) distance = source.minY - target.maxY;
			if (direction === 'down' && horizontalOverlap) distance = target.minY - source.maxY;
			if (direction === 'left' && verticalOverlap) distance = source.minX - target.maxX;
			if (direction === 'right' && verticalOverlap) distance = target.minX - source.maxX;
			if (distance < 0) continue;

			const centerDistance = getCenterDistance(node, candidate);
			if (!best || distance < best.distance || (distance === best.distance && centerDistance < best.centerDistance)) {
				best = { node: candidate, distance, centerDistance };
			}
		}

		return best?.node ?? null;
	}
}

// Walk upward until the first-level root branch decides left/right direction.
function getBranchDirection(canvas: Canvas, node: CanvasNode, adapter?: CanvasAdapter): 'left' | 'right' {
	let current = node;
	const visited = new Set<string>();
	while (!visited.has(current.id)) {
		visited.add(current.id);
		const incomingEdge = adapter?.getPrimaryIncomingEdge(canvas, current);
		if (!incomingEdge) return 'right';

		const edgeData = incomingEdge.getData();
		const parent = canvas.nodes.get(edgeData.fromNode);
		if (!parent) return 'right';
		if (!adapter?.getPrimaryIncomingEdge(canvas, parent)) return edgeData.fromSide === 'left' ? 'left' : 'right';
		current = parent;
	}
	return 'right';
}

function getIncomingEdgeFromSide(canvas: Canvas, node: CanvasNode, adapter: CanvasAdapter): 'left' | 'right' {
	return adapter.getPrimaryIncomingEdge(canvas, node)?.getData().fromSide === 'left' ? 'left' : 'right';
}

function getCenterDistance(a: CanvasNode, b: CanvasNode): number {
	const ax = a.x + a.width / 2;
	const ay = a.y + a.height / 2;
	const bx = b.x + b.width / 2;
	const by = b.y + b.height / 2;
	return Math.hypot(ax - bx, ay - by);
}
