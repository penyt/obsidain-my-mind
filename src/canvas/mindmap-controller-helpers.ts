//Shared helper functions for MindmapController and Canvas lifecycle modules

//------------ import dependencies ------------
import { CanvasAdapter } from './canvas-adapter';
import { NavigationDirection } from './navigation';
import { Canvas, CanvasEdge, CanvasEdgeData, CanvasNode, CanvasNodeSide } from './canvas-types';

// Compact edge endpoint snapshot used by requestSave diffing.
export interface EdgeEndpointSnapshot {
	id: string;
	fromNode: string;
	fromSide?: string;
	toNode: string;
	toSide?: string;
}

//------------ edit lifecycle helpers ------------
/** Wait until Obsidian has replaced the editor iframe with a visible preview. */
export async function waitForNativePreview(
	node: CanvasNode,
	fallbackStopEditing: () => void,
	nextFrame: () => Promise<boolean>,
	isValid: () => boolean,
): Promise<boolean> {
	for (let index = 0; index < 8; index += 1) {
		if (!isValid()) return false;
		if (isNativePreviewReady(node)) return true;
		if (!(await nextFrame())) return false;
	}

	if (node.isEditing) {
		if (!isValid()) return false;
		fallbackStopEditing();
		for (let index = 0; index < 8; index += 1) {
			if (!isValid()) return false;
			if (isNativePreviewReady(node)) return true;
			if (!(await nextFrame())) return false;
		}
	}

	return isValid() && isNativePreviewReady(node);
}

export function clearVisiblePreviewSizerMinHeight(node: CanvasNode): void {
	const sizer = getVisiblePreviewSizer(node);
	sizer?.style.removeProperty('min-height');
}

export function getEventDocument(event: Event): Document | null {
	return event.target instanceof Node ? event.target.ownerDocument : null;
}

export function getEditorTextSnapshot(document: Document): string | null {
	const lines = Array.from(document.querySelectorAll('.cm-line'))
		.filter((element): element is HTMLElement => element.instanceOf(HTMLElement));
	if (lines.length === 0) return null;
	return lines.map((line) => line.textContent ?? '').join('\n');
}

//------------ selection helpers ------------
export function getSelectedNodes(canvas: Canvas): CanvasNode[] {
	return Array.from(canvas.selection.values())
		.map((element) => canvas.nodes.get(element.id))
		.filter((node): node is CanvasNode => node !== undefined);
}

// Expand drag selection to structural descendants of highest selected nodes.
export function expandSelectionWithDescendants(
	canvas: Canvas,
	adapter: CanvasAdapter,
	highestSelectedNodes: CanvasNode[],
	selectedNodes: CanvasNode[],
): CanvasNode[] {
	const expandedById = new Map(selectedNodes.map((node) => [node.id, node]));

	for (const selectedNode of highestSelectedNodes) {
		for (const descendant of getDescendants(canvas, adapter, selectedNode)) {
			expandedById.set(descendant.id, descendant);
		}
	}

	return Array.from(expandedById.values());
}

export function restoreExistingSelection(canvas: Canvas, originalSelection: CanvasNode[]): void {
	const existingNodes = originalSelection.filter((node) => canvas.nodes.has(node.id));
	if (existingNodes.length === 0) return;
	setSelection(canvas, existingNodes);
}

//------------ Canvas lifecycle helpers ------------
export function isCanvasConnected(canvas: Canvas): boolean {
	const element = canvas.wrapperEl ?? canvas.canvasEl;
	return element?.isConnected ?? true;
}

/** Snapshot only edge endpoints; colors/labels are irrelevant for branch-side relayout. */
export function getEdgeEndpointSnapshot(canvas: Canvas): Map<string, EdgeEndpointSnapshot> {
	return new Map(
		canvas.getData().edges.map((edge) => [edge.id, toEdgeEndpointSnapshot(edge)]),
	);
}

// Return endpoint changes between two snapshots.
export function getEdgeEndpointChanges(
	previousSnapshot: Map<string, EdgeEndpointSnapshot>,
	currentSnapshot: Map<string, EdgeEndpointSnapshot>,
): Array<{ id: string; previous: EdgeEndpointSnapshot | null; current: EdgeEndpointSnapshot | null }> {
	const ids = new Set([...previousSnapshot.keys(), ...currentSnapshot.keys()]);
	const changes: Array<{ id: string; previous: EdgeEndpointSnapshot | null; current: EdgeEndpointSnapshot | null }> = [];
	for (const id of ids) {
		const previous = previousSnapshot.get(id) ?? null;
		const current = currentSnapshot.get(id) ?? null;
		if (areEdgeEndpointSnapshotsEqual(previous, current)) continue;
		changes.push({ id, previous, current });
	}
	return changes;
}

/** Return the structural edge from a root node to a first-level branch node. */
export function getRootMainBranchEdge(canvas: Canvas, adapter: CanvasAdapter, node: CanvasNode): CanvasEdge | null {
	const edge = adapter.getPrimaryIncomingEdge(canvas, node);
	if (!edge) return null;

	const parent = canvas.nodes.get(edge.getData().fromNode);
	if (!parent || adapter.getPrimaryIncomingEdge(canvas, parent) !== null) return null;
	return edge;
}

export function getOppositeNodeSide(side: CanvasNodeSide): CanvasNodeSide {
	return side === 'left' ? 'right' : 'left';
}

// Consume plugin-originated change signatures one time.
export function isSelfChange(
	selfChanges: Set<string>,
	change: { id: string; previous: EdgeEndpointSnapshot | null; current: EdgeEndpointSnapshot | null },
): boolean {
	const signature = getEdgeChangeSignature(change);
	if (!selfChanges.has(signature)) return false;
	selfChanges.delete(signature);
	return true;
}

export function getEdgeChangeSignature(change: { id: string; previous: EdgeEndpointSnapshot | null; current: EdgeEndpointSnapshot | null }): string {
	return JSON.stringify(change);
}

export function hasTransientEndpoint(
	canvas: Canvas,
	change: { current: EdgeEndpointSnapshot | null },
): boolean {
	const current = change.current;
	return current !== null && (!canvas.nodes.has(current.fromNode) || !canvas.nodes.has(current.toNode));
}

// True only when the structural root edge changed side.
export function isRootMainBranchSideChange(
	canvas: Canvas,
	adapter: CanvasAdapter,
	change: { previous: EdgeEndpointSnapshot | null; current: EdgeEndpointSnapshot | null },
): boolean {
	const previous = change.previous;
	const current = change.current;
	if (!previous || !current) return false;
	if (previous.fromNode !== current.fromNode || previous.toNode !== current.toNode) return false;
	if (previous.fromSide === current.fromSide) return false;
	if (current.fromSide !== 'left' && current.fromSide !== 'right') return false;

	const fromNode = canvas.nodes.get(current.fromNode);
	const toNode = canvas.nodes.get(current.toNode);
	if (!fromNode || !toNode) return false;

	const primaryIncoming = adapter.getPrimaryIncomingEdge(canvas, toNode);
	return primaryIncoming?.getData().id === current.id && adapter.getPrimaryIncomingEdge(canvas, fromNode) === null;
}

export function isCanvasConnecting(canvas: Canvas): boolean {
	return canvas.canvasEl?.hasClass('is-connecting') === true;
}

// Ambiguous ancestor paths are skipped for subtree drag safety.
export function hasAmbiguousAncestor(canvas: Canvas, adapter: CanvasAdapter, node: CanvasNode): boolean {
	let current = node;
	const visited = new Set<string>();

	while (!visited.has(current.id)) {
		visited.add(current.id);
		const parents = adapter.getParents(canvas, current);
		if (parents.length > 1) return true;
		if (parents.length === 0) return false;

		const parent = parents[0];
		if (!parent) return false;
		current = parent;
	}

	return true;
}

export function setSelection(canvas: Canvas, nodes: CanvasNode[]): void {
	const update = () => {
		canvas.selection.clear();
		for (const node of nodes) {
			canvas.selection.add(node);
		}
	};

	if (canvas.updateSelection) {
		canvas.updateSelection(update);
		return;
	}

	update();
}

export function isEventInsideNode(event: PointerEvent, node: CanvasNode): boolean {
	if (!(event.target instanceof HTMLElement)) return false;
	const nodeElement = node.nodeEl ?? node.containerEl;
	return nodeElement ? nodeElement.contains(event.target) : false;
}

export function isPointerNearNodeEdge(event: PointerEvent, node: CanvasNode): boolean {
	const nodeElement = node.nodeEl ?? node.containerEl;
	if (!nodeElement) return false;

	const rect = nodeElement.getBoundingClientRect();
	const isInsideNode = event.clientX >= rect.left &&
		event.clientX <= rect.right &&
		event.clientY >= rect.top &&
		event.clientY <= rect.bottom;
	if (!isInsideNode) return false;

	const edgeThreshold = 10;
	return event.clientX - rect.left <= edgeThreshold ||
		rect.right - event.clientX <= edgeThreshold ||
		event.clientY - rect.top <= edgeThreshold ||
		rect.bottom - event.clientY <= edgeThreshold;
}

export function isCanvasResizeInteraction(event: PointerEvent): boolean {
	if (!(event.target instanceof HTMLElement)) return false;
	return event.target.closest('.canvas-node-resizer, .canvas-node-connection-point') !== null;
}

//------------ DOM helpers ------------
export function getCanvasControlGroup(canvas: Canvas): HTMLElement | null {
	const viewContainer = canvas.view.containerEl;
	const controls =
		viewContainer.querySelector('.canvas-controls') ??
		canvas.wrapperEl?.querySelector('.canvas-controls') ??
		canvas.canvasControlsEl;

	const firstRaisedGroup = controls?.querySelector('.canvas-control-group.mod-raised');
	if (firstRaisedGroup instanceof HTMLElement) return firstRaisedGroup;

	const firstGroup = controls?.querySelector('.canvas-control-group');
	if (firstGroup instanceof HTMLElement) return firstGroup;

	if (canvas.quickSettingsButton?.parentElement instanceof HTMLElement) {
		return canvas.quickSettingsButton.parentElement;
	}

	if (canvas.canvasControlsEl instanceof HTMLElement) return canvas.canvasControlsEl;
	return null;
}

//------------ keyboard helpers ------------
export function isDeleteKey(key: string): boolean {
	return key === 'Delete' || key === 'Backspace';
}

export function isSpaceKey(event: KeyboardEvent): boolean {
	return event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
}

export function hasNavigationModifier(event: KeyboardEvent): boolean {
	return event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
}

export function getNudgeDelta(direction: NavigationDirection, distance: number): { x: number; y: number } {
	if (direction === 'up') return { x: 0, y: -distance };
	if (direction === 'down') return { x: 0, y: distance };
	if (direction === 'left') return { x: -distance, y: 0 };
	return { x: distance, y: 0 };
}

export function getNavigationDirection(key: string): NavigationDirection | null {
	if (key === 'ArrowUp') return 'up';
	if (key === 'ArrowDown') return 'down';
	if (key === 'ArrowLeft') return 'left';
	if (key === 'ArrowRight') return 'right';
	return null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.closest('.cm-editor')) return true;
	return target.matches('input, textarea, select, button');
}

function isNativePreviewReady(node: CanvasNode): boolean {
	return !node.isEditing &&
		!hasEditorIframe(node) &&
		getVisiblePreview(node) !== null;
}

function hasEditorIframe(node: CanvasNode): boolean {
	return node.nodeEl?.querySelector('iframe') !== null;
}

function getVisiblePreview(node: CanvasNode): HTMLElement | null {
	const previews = Array.from(node.nodeEl?.querySelectorAll('.markdown-preview-view') ?? []);
	return previews.find((element): element is HTMLElement => {
		if (!element.instanceOf(HTMLElement)) return false;
		return isVisibleElement(element);
	}) ?? null;
}

function getVisiblePreviewSizer(node: CanvasNode): HTMLElement | null {
	const preview = getVisiblePreview(node);
	const sizer = preview?.querySelector('.markdown-preview-sizer');
	return sizer?.instanceOf(HTMLElement) && isVisibleElement(sizer) ? sizer : null;
}

function isVisibleElement(element: HTMLElement): boolean {
	if (!element.isConnected) return false;
	const view = element.ownerDocument.defaultView;
	let current: HTMLElement | null = element;
	while (current) {
		const style = view?.getComputedStyle(current);
		if (style?.display === 'none' || style?.visibility === 'hidden') return false;
		current = current.parentElement;
	}
	return true;
}

function toEdgeEndpointSnapshot(edge: CanvasEdgeData): EdgeEndpointSnapshot {
	return {
		id: edge.id,
		fromNode: edge.fromNode,
		fromSide: edge.fromSide,
		toNode: edge.toNode,
		toSide: edge.toSide,
	};
}

function areEdgeEndpointSnapshotsEqual(
	previous: EdgeEndpointSnapshot | null,
	current: EdgeEndpointSnapshot | null,
): boolean {
	return previous?.fromNode === current?.fromNode &&
		previous?.fromSide === current?.fromSide &&
		previous?.toNode === current?.toNode &&
		previous?.toSide === current?.toSide;
}

function getDescendants(canvas: Canvas, adapter: CanvasAdapter, root: CanvasNode): CanvasNode[] {
	const descendants: CanvasNode[] = [];
	const visited = new Set<string>([root.id]);
	const queue = [root];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		for (const child of adapter.getChildren(canvas, current)) {
			if (visited.has(child.id)) continue;
			visited.add(child.id);
			descendants.push(child);
			queue.push(child);
		}
	}

	return descendants;
}
