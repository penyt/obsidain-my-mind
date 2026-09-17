//Canvas context menu items for My Mind actions

//------------ import dependencies ------------
import { Menu } from 'obsidian';
import { CanvasAdapter } from './canvas-adapter';
import { NodeOperations } from './node-operations';
import { Canvas, CanvasEdge, CanvasNode, CanvasNodeSide } from './canvas-types';
import { getRootMainBranchEdge } from './mindmap-controller-helpers';

/** Adds My Mind actions to Canvas node and edge context menus. */
//------------ context menu controller ------------
export class CanvasContextMenuController {
	constructor(
		private readonly adapter: CanvasAdapter,
		private readonly isEnabled: (canvas: Canvas) => boolean,
		private readonly getOperations: () => NodeOperations,
		private readonly isRootBranchDirectionEnabled: () => boolean,
		private readonly moveRootBranch: (edge: CanvasEdge, direction: CanvasNodeSide) => void,
	) {}

	// Add node actions for manual layout reset and root branch direction.
	addNodeMenuItems(menu: Menu, node: CanvasNode): void {
		this.addManualPositionMenuItem(menu, node);
		this.addBranchDirectionMenuItems(menu, node);
	}

	// Add edge actions for choosing the primary structural parent connection.
	addEdgeMenuItems(menu: Menu, edge: CanvasEdge): void {
		const canvas = edge.canvas;
		if (!this.isEnabled(canvas) || canvas.readonly) return;

		const child = canvas.nodes.get(edge.getData().toNode);
		if (!child) return;
		const currentPrimary = this.adapter.getPrimaryIncomingEdge(canvas, child);
		if (currentPrimary?.getData().id === edge.getData().id && edge.getData().myMindStructuralEdge === true) return;

		menu.addItem((item) => {
			item
				.setSection('canvas')
				.setTitle('Set as primary connection')
				.setIcon('git-branch')
				.onClick(() => this.setPrimaryConnection(edge));
		});
	}

	// Show reset action only when target node(s) have manual-position markers.
	private addManualPositionMenuItem(menu: Menu, node: CanvasNode): void {
		const canvas = node.canvas;
		if (!this.isEnabled(canvas) || canvas.readonly) return;

		const targets = this.getManualPositionMenuTargets(canvas, node);
		const resetTargets = this.getManualPositionResetTargets(canvas, targets);
		if (!resetTargets.some((target) => target.getData().myMindManualPosition === true)) return;

		menu.addItem((item) => {
			item
				.setSection('canvas')
				.setTitle('Return to automatic layout')
				.setIcon('refresh-cw')
				.onClick(() => this.clearManualPositionsAndRelayout(canvas, resetTargets));
		});
	}

	private getManualPositionMenuTargets(canvas: Canvas, node: CanvasNode): CanvasNode[] {
		const selectedNodes = this.getSelectedCanvasNodes(canvas);
		if (selectedNodes.length > 1 && selectedNodes.some((selectedNode) => selectedNode.id === node.id)) {
			return selectedNodes;
		}

		return [node];
	}

	private getSelectedCanvasNodes(canvas: Canvas): CanvasNode[] {
		return Array.from(canvas.selection.values())
			.map((element) => canvas.nodes.get(element.id))
			.filter((selectedNode): selectedNode is CanvasNode => selectedNode !== undefined);
	}

	private getManualPositionResetTargets(canvas: Canvas, roots: CanvasNode[]): CanvasNode[] {
		const targetsById = new Map<string, CanvasNode>();
		for (const root of roots) {
			const resetRoot = this.getHighestManualAncestor(canvas, root);
			for (const node of this.getStructuralSubtreeNodes(canvas, resetRoot)) {
				targetsById.set(node.id, node);
			}
		}
		return Array.from(targetsById.values());
	}

	private getHighestManualAncestor(canvas: Canvas, node: CanvasNode): CanvasNode {
		let current = node;
		const visited = new Set<string>();

		while (!visited.has(current.id)) {
			visited.add(current.id);
			const parent = this.adapter.getParents(canvas, current)[0];
			if (!parent || parent.getData().myMindManualPosition !== true) return current;
			current = parent;
		}

		return node;
	}

	private getStructuralSubtreeNodes(canvas: Canvas, root: CanvasNode): CanvasNode[] {
		const nodes: CanvasNode[] = [];
		const visited = new Set<string>();
		const queue = [root];

		while (queue.length > 0) {
			const node = queue.shift();
			if (!node || visited.has(node.id)) continue;
			visited.add(node.id);
			nodes.push(node);
			queue.push(...this.adapter.getChildren(canvas, node));
		}

		return nodes;
	}

	/** Clear selected manual-position markers and relayout once as one batch. */
	private clearManualPositionsAndRelayout(canvas: Canvas, targets: CanvasNode[]): void {
		const clearedNodes = targets.filter((target) => this.adapter.clearNodeManualPositionWithoutSave(target));
		if (clearedNodes.length === 0) return;

		const relayoutNode = clearedNodes[0];
		if (!relayoutNode) return;
		const relayoutChanged = this.getOperations().relayoutTreeContaining(canvas, relayoutNode);
		if (!relayoutChanged) this.adapter.commitCanvasBatch(canvas, true, 'push');
	}

	// Root branch direction actions only apply to first-level branch nodes.
	private addBranchDirectionMenuItems(menu: Menu, node: CanvasNode): void {
		const canvas = node.canvas;
		if (!this.isRootBranchDirectionEnabled() || !this.isEnabled(canvas) || canvas.readonly) return;

		const edge = getRootMainBranchEdge(canvas, this.adapter, node);
		if (!edge) return;

		const currentSide = edge.getData().fromSide === 'left' ? 'left' : 'right';
		for (const side of ['left', 'right'] as const) {
			menu.addItem((item) => {
				item
					.setSection('canvas')
					.setTitle(side === 'left' ? 'Move branch to left' : 'Move branch to right')
					.setIcon(side === 'left' ? 'arrow-left' : 'arrow-right')
					.setDisabled(side === currentSide)
					.onClick(() => this.moveRootBranch(edge, side));
			});
		}
	}

	/** Promote a visible cross-link to the child's structural parent edge. */
	private setPrimaryConnection(edge: CanvasEdge): void {
		const canvas = edge.canvas;
		if (canvas.readonly || !this.isEnabled(canvas)) return;

		const changed = this.adapter.setStructuralIncomingEdgeWithoutSave(canvas, edge);
		const child = canvas.nodes.get(edge.getData().toNode);
		const layoutChanged = child ? this.getOperations().relayoutTreeContaining(canvas, child) : false;
		if (changed && !layoutChanged) this.adapter.commitCanvasBatch(canvas, true, 'push');
	}
}
