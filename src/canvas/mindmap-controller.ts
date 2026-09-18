//Main runtime coordinator for My Mind Canvas workflows

//------------ import dependencies ------------
import { App, EventRef, Menu, Notice, Scope, setIcon, setTooltip } from 'obsidian';
import MyMindPlugin from '../main';
import { CanvasAdapter } from './canvas-adapter';
import { CanvasContextMenuController } from './canvas-context-menu';
import { CanvasEdgeMonitor } from './canvas-edge-monitor';
import { CanvasIframeListeners } from './canvas-iframe-listeners';
import { CanvasWorkScheduler } from './canvas-work-scheduler';
import { MindmapLayout } from './layout';
import { MindmapNavigation, NavigationDirection } from './navigation';
import { NodeOperations } from './node-operations';
import { fitTextNodeToContent } from './node-sizing';
import { Canvas, CanvasEdge, CanvasNode, CanvasNodeSide } from './canvas-types';
import {
	clearVisiblePreviewSizerMinHeight,
	expandSelectionWithDescendants,
	getCanvasControlGroup,
	getEdgeEndpointSnapshot,
	getEditorTextSnapshot,
	getEventDocument,
	getNavigationDirection,
	getNudgeDelta,
	getOppositeNodeSide,
	getRootMainBranchEdge,
	getSelectedNodes,
	hasAmbiguousAncestor,
	hasNavigationModifier,
	isCanvasConnected,
	isCanvasResizeInteraction,
	isDeleteKey,
	isEditableTarget,
	isEventInsideNode,
	isPointerNearNodeEdge,
	isSpaceKey,
	restoreExistingSelection,
	setSelection,
	waitForNativePreview,
} from './mindmap-controller-helpers';

//------------ DOM constants ------------
const TOGGLE_ID = 'my-mind-canvas-toggle';
const AUTO_LAYOUT_BUTTON_ID = 'my-mind-auto-layout';
const TOGGLE_ACTIVE_CLASS = 'is-enabled';

//------------ private Canvas menu event types ------------
type CanvasNodeMenuHandler = (menu: Menu, node: CanvasNode) => void;
type CanvasEdgeMenuHandler = (menu: Menu, edge: CanvasEdge) => void;

type WorkspaceWithCanvasMenus = App['workspace'] & {
	on(name: 'canvas:node-menu', callback: CanvasNodeMenuHandler): EventRef;
	on(name: 'canvas:edge-menu', callback: CanvasEdgeMenuHandler): EventRef;
};

// this class wires Obsidian events, commands, keyboard handling, 
// drag handling, and edit-finish flow

//------------ controller class ------------
export class MindmapController {
	private adapter: CanvasAdapter;
	private navigation: MindmapNavigation;
	private readonly contextMenus: CanvasContextMenuController;
	private readonly edgeMonitor: CanvasEdgeMonitor;
	private readonly iframeListeners: CanvasIframeListeners;
	private readonly finishingNodeIds = new Set<string>();
	private readonly handledKeyEvents = new WeakSet<KeyboardEvent>();
	private readonly canvasKeydownCleanups = new WeakMap<Canvas, () => void>();
	private readonly scheduler = new CanvasWorkScheduler((canvas) => this.isScheduledCanvasActive(canvas));
	private navigationScope: Scope | null = null;
	private attachedCanvas: Canvas | null = null;

	// wire focused modules together
	constructor(private readonly plugin: MyMindPlugin) {
		this.adapter = new CanvasAdapter(plugin.app);
		this.navigation = new MindmapNavigation(this.adapter);
		this.edgeMonitor = new CanvasEdgeMonitor(
			this.adapter,
			this.scheduler,
			(canvas, historyMode) => this.getOperations().autoLayout(canvas, historyMode),
		);
		this.contextMenus = new CanvasContextMenuController(
			this.adapter,
			(canvas) => this.isEnabled(canvas),
			() => this.getOperations(),
			() => this.plugin.settings.rootBranchDirections,
			(edge, direction) => this.moveRootBranch(edge, direction),
		);
		this.iframeListeners = new CanvasIframeListeners(
			(event) => this.handleKeydown(event),
			(canvas, node, textSnapshot) => void this.finishEditing(canvas, node, textSnapshot),
		);
	}

	// register workspace, keyboard, pointer, and cleanup handlers
	load(): void {
		this.scheduler.reset();
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => {
				this.scheduleRenderToggle();
				this.refreshNavigationScope();
				this.scheduleCurrentCanvasAttachment();
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('layout-change', () => {
				this.scheduleRenderToggle();
				this.scheduleCurrentCanvasAttachment();
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-open', () => {
				this.scheduleRenderToggle();
				this.scheduleCurrentCanvasAttachment();
			}),
		);
		this.plugin.registerEvent(
			(this.plugin.app.workspace as WorkspaceWithCanvasMenus).on('canvas:node-menu', (menu, node) => {
				this.contextMenus.addNodeMenuItems(menu, node);
			}),
		);
		this.plugin.registerEvent(
			(this.plugin.app.workspace as WorkspaceWithCanvasMenus).on('canvas:edge-menu', (menu, edge) => {
				this.contextMenus.addEdgeMenuItems(menu, edge);
			}),
		);

		this.plugin.registerDomEvent(
			activeDocument,
			'keydown',
			(event) => this.handleKeydown(event),
			{ capture: true },
		);
		this.plugin.registerDomEvent(
			activeDocument,
			'pointerdown',
			(event) => this.handlePointerDown(event),
			{ capture: true },
		);

		this.plugin.register(() => this.dispose());

		this.scheduleRenderToggle();
		this.refreshNavigationScope();
		this.scheduleCurrentCanvasAttachment();
	}

	/** Render Canvas controls owned by My Mind for the active Canvas. */
	renderToggle(): void {
		const canvas = this.getCurrentCanvas();
		if (!canvas) return;

		const container = getCanvasControlGroup(canvas);
		if (!container) return;

		container.querySelector(`#${TOGGLE_ID}`)?.remove();
		container.querySelector(`#${AUTO_LAYOUT_BUTTON_ID}`)?.remove();

		const button = container.createDiv({
			cls: ['canvas-control-item', 'my-mind-toggle'],
			attr: { id: TOGGLE_ID, role: 'button' },
		});
		button.tabIndex = 0;
		setIcon(button, 'git-branch-plus');
		setTooltip(button, 'Toggle mindmap mode', { placement: 'left' });

		button.classList.toggle(TOGGLE_ACTIVE_CLASS, this.isEnabled(canvas));
		button.ariaLabel = 'Toggle mindmap mode';
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			void this.setEnabled(canvas, !this.isEnabled(canvas)).then(() => {
				this.renderToggle();
			});
		});
		button.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			button.click();
		});

		if (this.isEnabled(canvas)) {
			this.createAutoLayoutButton(container, canvas);
		}
	}

	// Create the secondary Canvas control below the mindmap toggle.
	private createAutoLayoutButton(container: HTMLElement, canvas: Canvas): HTMLElement {
		const button = container.createDiv({
			cls: ['canvas-control-item', 'my-mind-auto-layout'],
			attr: { id: AUTO_LAYOUT_BUTTON_ID, role: 'button' },
		});
		button.tabIndex = 0;
		button.ariaLabel = 'Auto layout current mindmap canvas';
		setIcon(button, 'layout-template');
		setTooltip(button, 'Auto layout current mindmap canvas', { placement: 'left' });

		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (canvas.readonly) {
				new Notice('This canvas is readonly');
				return;
			}
			const changed = this.autoLayoutCurrentCanvas();
			new Notice(changed ? 'Auto layout complete' : 'Auto layout already up to date');
		});
		button.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			button.click();
		});
		return button;
	}

	// Command palette availability helper.
	hasCurrentCanvas(): boolean {
		return this.getCurrentCanvas() !== null;
	}

	// Command palette availability helper for mindmap-only commands.
	isCurrentCanvasEnabled(): boolean {
		const canvas = this.getCurrentCanvas();
		return canvas ? this.isEnabled(canvas) : false;
	}

	// mindmap mode toggle
	async toggleCurrentCanvas(): Promise<void> {
		const canvas = this.getCurrentCanvas();
		if (!canvas) return;
		await this.setEnabled(canvas, !this.isEnabled(canvas));
		this.renderToggle();
	}

	// Mindmap mode is stored per Canvas file path.
	isEnabled(canvas: Canvas): boolean {
		const key = this.adapter.getCanvasKey(canvas);
		return key ? this.plugin.settings.mindmapEnabledByCanvasPath[key] === true : false;
	}

	// Toggle mode and attach/detach runtime helpers for this Canvas.
	async setEnabled(canvas: Canvas, enabled: boolean): Promise<void> {
		const key = this.adapter.getCanvasKey(canvas);
		if (!key) return;

		this.plugin.settings.mindmapEnabledByCanvasPath[key] = enabled;
		await this.plugin.saveSettings();

		if (enabled) {
			new Notice('Mindmap mode enabled');
			this.getOperations().applyFirstLevelColors(canvas, true);
			this.pushNavigationScopeIfNeeded();
			this.attachCanvas(canvas);
		} else {
			new Notice('Mindmap mode disabled');
			this.popNavigationScope();
			this.detachCanvas(canvas);
		}
	}

	// Re-apply colors only to the active enabled Canvas.
	applyFirstLevelColorsToCurrentCanvas(): void {
		const canvas = this.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas)) return;
		this.getOperations().applyFirstLevelColors(canvas);
	}

	// Public command/button entry for full auto layout.
	autoLayoutCurrentCanvas(): boolean {
		const canvas = this.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas) || canvas.readonly) return false;

		return this.getOperations().autoLayout(canvas);
	}

	// Reattach edge monitoring when root direction setting changes.
	refreshRootBranchDirections(): void {
		if (!this.plugin.settings.rootBranchDirections) {
			this.edgeMonitor.disableAll();
			return;
		}
		this.scheduleCurrentCanvasAttachment();
	}

	// Hotkey command entry for branch direction changes.
	moveSelectedRootBranch(direction: CanvasNodeSide): boolean {
		const result = this.getSelectedRootBranchEdgeForDirection(direction);
		if (!result.edge) {
			new Notice(result.reason);
			return false;
		}

		this.moveRootBranch(result.edge, direction);
		return true;
	}

	// Validate user context and return a Notice reason when unavailable.
	private getSelectedRootBranchEdgeForDirection(direction: CanvasNodeSide): { edge: CanvasEdge | null; reason: string } {
		if (direction !== 'left' && direction !== 'right') return { edge: null, reason: 'Branch direction must be left or right' };

		const canvas = this.getCurrentCanvas();
		if (!canvas) return { edge: null, reason: 'Open a canvas first' };
		if (!this.plugin.settings.rootBranchDirections) return { edge: null, reason: 'Enable Root branch direction in My Mind settings' };
		if (!this.isEnabled(canvas)) return { edge: null, reason: 'Enable mindmap mode for this canvas first' };
		if (canvas.readonly) return { edge: null, reason: 'This canvas is readonly' };

		const node = this.adapter.getSelectedNode(canvas);
		if (!node) return { edge: null, reason: 'Select exactly one first-level branch node' };

		const edge = getRootMainBranchEdge(canvas, this.adapter, node);
		if (!edge) return { edge: null, reason: 'Selected node is not a first-level branch' };
		if (edge.getData().fromSide === direction) return { edge: null, reason: `Branch is already on the ${direction}` };
		return { edge, reason: '' };
	}


	// Change root edge side, relayout, and suppress the resulting self-change diff.
	private moveRootBranch(edge: CanvasEdge, direction: CanvasNodeSide): void {
		const canvas = edge.canvas;
		if (direction !== 'left' && direction !== 'right') return;

		const beforeLayout = getEdgeEndpointSnapshot(canvas);
		const edgeChanged = this.adapter.setEdgeSidesWithoutSave(edge, direction, getOppositeNodeSide(direction));
		const layoutChanged = this.getOperations().autoLayout(canvas);
		if (edgeChanged && !layoutChanged) this.adapter.commitCanvasBatch(canvas, true, 'push');
		this.edgeMonitor.recordSelfChanges(canvas, beforeLayout);
	}

	private getCurrentCanvas(): Canvas | null {
		return this.adapter.getCurrentCanvas();
	}

	private getKeyboardCanvas(): Canvas | null {
		const currentCanvas = this.adapter.getCurrentCanvas();
		if (currentCanvas) return currentCanvas;
		if (!this.attachedCanvas || !this.isEnabled(this.attachedCanvas) || !isCanvasConnected(this.attachedCanvas)) return null;
		return this.attachedCanvas;
	}


	private isScheduledCanvasActive(canvas: Canvas): boolean {
		return (this.attachedCanvas === canvas || this.getCurrentCanvas() === canvas) &&
			this.isEnabled(canvas) &&
			isCanvasConnected(canvas);
	}

	// Canvas controls can render late, so retry a few times without polling forever.
	private scheduleRenderToggle(): void {
		for (const delay of [100, 300, 700, 1200]) {
			this.scheduler.scheduleTimeout(() => this.renderToggle(), delay);
		}
	}

	// Attach to active Canvas after workspace/layout changes settle.
	private scheduleCurrentCanvasAttachment(): void {
		this.edgeMonitor.cleanupDetached();
		for (const delay of [0, 100, 300, 700]) {
			this.scheduler.scheduleTimeout(() => this.attachCurrentCanvasIfNeeded(), delay);
		}
	}

	private attachCurrentCanvasIfNeeded(): void {
		this.edgeMonitor.cleanupDetached();
		const canvas = this.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas)) {
			if (this.attachedCanvas) this.detachCanvas(this.attachedCanvas);
			this.popNavigationScope();
			return;
		}

		this.attachCanvas(canvas);
	}

	// Attach lifecycle helpers for exactly one active Canvas.
	private attachCanvas(canvas: Canvas): void {
		if (this.attachedCanvas && this.attachedCanvas !== canvas) this.detachCanvas(this.attachedCanvas);
		this.attachedCanvas = canvas;
		this.attachCanvasKeyboard(canvas);
		this.attachCanvasIframes(canvas);
		if (this.plugin.settings.rootBranchDirections) this.edgeMonitor.ensure(canvas);
	}

	// Detach helpers and cancel delayed work tied to this Canvas.
	private detachCanvas(canvas: Canvas): void {
		this.scheduler.cancelPendingWork(canvas);
		this.scheduler.clearPointerListeners();
		this.detachCanvasKeyboard(canvas);
		if (this.attachedCanvas === canvas) {
			this.detachCanvasIframes();
			this.attachedCanvas = null;
		}
		this.edgeMonitor.disable(canvas);
	}

	private attachCanvasKeyboard(canvas: Canvas): void {
		if (this.canvasKeydownCleanups.has(canvas)) return;
		const targets = [canvas.wrapperEl, canvas.canvasEl]
			.filter((target): target is HTMLElement => target instanceof HTMLElement)
			.filter((target, index, array) => array.indexOf(target) === index);
		if (targets.length === 0) return;

		const listener = (event: KeyboardEvent) => this.handleKeydown(event);
		for (const target of targets) {
			target.addEventListener('keydown', listener, { capture: true });
		}
		this.canvasKeydownCleanups.set(canvas, () => {
			for (const target of targets) {
				target.removeEventListener('keydown', listener, { capture: true });
			}
		});
	}

	private detachCanvasKeyboard(canvas: Canvas): void {
		this.canvasKeydownCleanups.get(canvas)?.();
		this.canvasKeydownCleanups.delete(canvas);
	}

	private attachCanvasIframes(canvas: Canvas): void {
		if (!this.isEnabled(canvas)) return;
		this.iframeListeners.attachCanvas(canvas);
	}

	private detachCanvasIframes(): void {
		this.iframeListeners.detachCanvas();
		this.finishingNodeIds.clear();
	}

	// Final cleanup registered with Obsidian plugin unload.
	private dispose(): void {
		if (!this.scheduler.dispose()) return;
		if (this.attachedCanvas) this.detachCanvas(this.attachedCanvas);
		else this.detachCanvasIframes();
		this.popNavigationScope();
		this.edgeMonitor.disableAll();
	}

	/** Handles manual drag marking and optional subtree-selection expansion. */
	private handlePointerDown(event: PointerEvent): void {
		const canvas = this.adapter.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas)) return;

		if (event.button !== 0) return;
		if (isCanvasResizeInteraction(event)) return;

		const selectedNodes = getSelectedNodes(canvas);
		if (Array.from(canvas.nodes.values()).some((node) => isEventInsideNode(event, node))) {
			this.trackManualDrag(canvas);
		}
		if (selectedNodes.length === 0 || selectedNodes.some((node) => node.isEditing)) return;
		if (!this.shouldUseSubtreeDrag()) return;
		if (!selectedNodes.some((node) => isEventInsideNode(event, node))) return;
		if (selectedNodes.some((node) => isPointerNearNodeEdge(event, node))) return;
		if (selectedNodes.some((node) => hasAmbiguousAncestor(canvas, this.adapter, node))) return;

		const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
		const highestSelectedNodes = selectedNodes.filter(
			(node) => !this.hasSelectedAncestor(canvas, node, selectedNodeIds),
		);
		const expandedSelection = expandSelectionWithDescendants(canvas, this.adapter, highestSelectedNodes, selectedNodes);
		if (expandedSelection.length === selectedNodes.length) return;

		setSelection(canvas, expandedSelection);

		const restoreSelection = () => {
			this.scheduler.scheduleTimeout(() => {
				if (!this.scheduler.canRun(canvas)) return;
				restoreExistingSelection(canvas, selectedNodes);
			}, 50, canvas);
		};
		this.scheduler.registerPointerEndListeners(restoreSelection);
	}

	// Settings gate for subtree drag behavior.
	private shouldUseSubtreeDrag(): boolean {
		return this.plugin.settings.subtreeDrag;
	}

	/** Document/iframe key handler for creation and edit-finish shortcuts. */
	private handleKeydown(event: KeyboardEvent): void {
		if (this.handledKeyEvents.has(event)) return;
		const canvas = this.getKeyboardCanvas();
		if (!canvas || !this.isEnabled(canvas)) return;
		this.handledKeyEvents.add(event);

		this.attachCanvasIframes(canvas);

		const selectedNodes = getSelectedNodes(canvas);
		if (selectedNodes.length === 0) return;

		if (isDeleteKey(event.key)) {
			this.selectParentOfHighestSelectionAfterDelete(canvas, selectedNodes);
			return;
		}

		const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
		if (!selectedNode) return;

		if (event.key === 'Escape') {
			const eventDocument = getEventDocument(event);
			const textSnapshot = eventDocument ? getEditorTextSnapshot(eventDocument) : null;
			void this.finishEditing(canvas, selectedNode, textSnapshot);
			return;
		}

		if (selectedNode.isEditing || isEditableTarget(event.target)) return;
		if (getNavigationDirection(event.key)) return;

		if (event.key === 'Tab') {
			this.consume(event);
			if (canvas.readonly) return;
			this.getOperations().createChild(canvas, selectedNode);
			return;
		}

		if (event.key === 'Enter' && !event.shiftKey) {
			this.consume(event);
			if (canvas.readonly) return;
			this.getOperations().createSibling(canvas, selectedNode);
			return;
		}

		if (isSpaceKey(event)) {
			this.consume(event);
			this.adapter.startEditing(selectedNode);
			return;
		}
	}


	// Register Arrow handling through Obsidian Scope so native shortcuts still fall through.
	private registerNavigationScopeHandlers(scope: Scope): void {
		scope.register([], 'ArrowUp', (event) => this.handleNavigationScopeArrow(event, 'up'));
		scope.register([], 'ArrowDown', (event) => this.handleNavigationScopeArrow(event, 'down'));
		scope.register([], 'ArrowLeft', (event) => this.handleNavigationScopeArrow(event, 'left'));
		scope.register([], 'ArrowRight', (event) => this.handleNavigationScopeArrow(event, 'right'));
		scope.register(['Shift'], 'ArrowUp', (event) => this.handleNudgeScopeArrow(event, 'up'));
		scope.register(['Shift'], 'ArrowDown', (event) => this.handleNudgeScopeArrow(event, 'down'));
		scope.register(['Shift'], 'ArrowLeft', (event) => this.handleNudgeScopeArrow(event, 'left'));
		scope.register(['Shift'], 'ArrowRight', (event) => this.handleNudgeScopeArrow(event, 'right'));
	}

	// Plain Arrow navigates a single selected node when enabled.
	private handleNavigationScopeArrow(event: KeyboardEvent, direction: NavigationDirection): false | undefined {
		if (hasNavigationModifier(event)) return undefined;

		const canvas = this.adapter.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas) || !this.plugin.settings.useArrowNavigation) return undefined;

		const selectedNodes = getSelectedNodes(canvas);
		if (selectedNodes.length !== 1) return undefined;

		const selectedNode = selectedNodes[0];
		if (!selectedNode || selectedNode.isEditing || isEditableTarget(event.target)) return undefined;

		this.navigate(canvas, selectedNode, direction);
		return false;
	}

	// Shift + Arrow moves all selected nodes and marks them manual-positioned.
	private handleNudgeScopeArrow(event: KeyboardEvent, direction: NavigationDirection): false | undefined {
		if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return undefined;

		const canvas = this.adapter.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas) || !this.plugin.settings.useArrowNavigation || canvas.readonly) return undefined;
		if (isEditableTarget(event.target)) return undefined;

		const selectedNodes = getSelectedNodes(canvas);
		if (selectedNodes.length === 0 || selectedNodes.some((node) => node.isEditing)) return undefined;

		this.nudgeNodes(canvas, selectedNodes, direction);
		return false;
	}

	// Batch selected-node movement into one history entry.
	private nudgeNodes(canvas: Canvas, nodes: CanvasNode[], direction: NavigationDirection): void {
		const delta = getNudgeDelta(direction, this.plugin.settings.shiftArrowNudgeDistance);
		let changed = false;
		for (const node of nodes) {
			changed = this.adapter.setNodePositionWithoutSave(node, node.x + delta.x, node.y + delta.y) || changed;
			changed = this.adapter.markNodeManualPositionWithoutSave(node) || changed;
		}
		this.adapter.commitCanvasBatch(canvas, changed, 'push');
	}

	/** Detect native Canvas drag movement and mark moved nodes as manual-positioned. */
	private trackManualDrag(canvas: Canvas): void {
		const positions = new Map(
			Array.from(canvas.nodes.values()).map((node) => [node.id, { x: node.x, y: node.y }]),
		);
		const markMovedNodes = () => {
			for (const delay of [0, 50, 150]) {
				this.scheduler.scheduleTimeout(() => {
					let changed = false;
					for (const node of canvas.nodes.values()) {
						const original = positions.get(node.id);
						if (!original) continue;
						if (Math.abs(node.x - original.x) < 1 && Math.abs(node.y - original.y) < 1) continue;

						changed = this.adapter.markNodeManualPositionWithoutSave(node) || changed;
					}
					this.adapter.commitCanvasBatch(canvas, changed, 'push');
				}, delay, canvas);
			}
		};

		this.scheduler.registerPointerEndListeners(markMovedNodes);
	}

	// Rebuild scope after active Canvas changes.
	private refreshNavigationScope(): void {
		this.popNavigationScope();
		this.scheduler.scheduleTimeout(() => this.pushNavigationScopeIfNeeded(), 0);
	}

	// Push one scope only for the active enabled Canvas.
	private pushNavigationScopeIfNeeded(): void {
		const canvas = this.adapter.getCurrentCanvas();
		if (!canvas || !this.isEnabled(canvas) || this.navigationScope) return;

		const scope = new Scope(canvas.view.scope ?? this.plugin.app.scope);
		this.registerNavigationScopeHandlers(scope);
		this.plugin.app.keymap.pushScope(scope);
		this.navigationScope = scope;
	}

	private popNavigationScope(): void {
		if (!this.navigationScope) return;

		this.plugin.app.keymap.popScope(this.navigationScope);
		this.navigationScope = null;
	}

	private navigate(canvas: Canvas, selectedNode: CanvasNode, direction: NavigationDirection): void {
		const nextNode = this.navigation.getNextNode(canvas, selectedNode, direction);
		if (!nextNode) return;
		this.adapter.selectAndRevealNode(canvas, nextNode, false);
	}

	// After native delete completes, recover selection to the unique direct parent.
	private selectParentOfHighestSelectionAfterDelete(canvas: Canvas, selectedNodes: CanvasNode[]): void {
		if (selectedNodes.some((node) => node.isEditing)) return;

		const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
		const parent = this.getUniqueParentOfHighestSelectedNodes(canvas, selectedNodes, selectedNodeIds);
		if (!parent) return;

		for (const delay of [50, 150, 300]) {
			this.scheduler.scheduleTimeout(() => {
				if (!canvas.nodes.has(parent.id)) return;
				if (selectedNodes.some((node) => canvas.nodes.has(node.id))) return;
				this.adapter.selectNode(canvas, parent);
			}, delay, canvas);
		}
	}

	// Multi-select delete only recovers selection when the parent is unambiguous.
	private getUniqueParentOfHighestSelectedNodes(
		canvas: Canvas,
		selectedNodes: CanvasNode[],
		selectedNodeIds: Set<string>,
	): CanvasNode | null {
		const highestSelectedNodes = selectedNodes.filter(
			(node) => !this.hasSelectedAncestor(canvas, node, selectedNodeIds),
		);
		const candidates = highestSelectedNodes
			.map((node) => {
				const parents = this.adapter.getParents(canvas, node);
				return parents.length === 1 ? parents[0] ?? null : null;
			})
			.filter((node): node is CanvasNode => node !== null)
			.filter((node) => !selectedNodeIds.has(node.id));

		const uniqueCandidates = new Map(candidates.map((node) => [node.id, node]));
		return uniqueCandidates.size === 1 ? uniqueCandidates.values().next().value ?? null : null;
	}

	// Used to collapse nested selected nodes to highest selected nodes.
	private hasSelectedAncestor(canvas: Canvas, node: CanvasNode, selectedNodeIds: Set<string>): boolean {
		let current = node;
		const visited = new Set<string>();

		while (!visited.has(current.id)) {
			visited.add(current.id);
			const parents = this.adapter.getParents(canvas, current);
			if (parents.length !== 1) return false;

			const parent = parents[0];
			if (!parent) return false;
			if (selectedNodeIds.has(parent.id)) return true;
			current = parent;
		}

		return false;
	}


	// Coalesce Esc and blur so one edit session runs one resize / layout job.
	private finishEditing(
		canvas: Canvas,
		selectedNode: CanvasNode,
		textSnapshot: string | null,
	): void {
		if (this.finishingNodeIds.has(selectedNode.id)) return;
		this.finishingNodeIds.add(selectedNode.id);

		this.scheduler.scheduleTimeout(() => {
			void this.finishEditingAfterNativeExit(canvas, selectedNode, textSnapshot);
		}, 0, canvas);
	}

	// Wait for Obsidian native edit exit, then resize / layout / select safely.
	private async finishEditingAfterNativeExit(
		canvas: Canvas,
		selectedNode: CanvasNode,
		textSnapshot: string | null,
	): Promise<void> {
		try {
			if (!this.canFinishEditing(canvas, selectedNode)) return;

			const ready = await waitForNativePreview(
				selectedNode,
				() => this.adapter.stopEditing(selectedNode),
				() => this.nextFrame(canvas),
				() => this.canFinishEditing(canvas, selectedNode),
			);
			if (!ready || !this.canFinishEditing(canvas, selectedNode)) return;

			const resized = fitTextNodeToContent(selectedNode, textSnapshot, { forceRender: true });
			if (!this.canFinishEditing(canvas, selectedNode)) return;
			const layoutChanged = resized ? this.getOperations().autoLayoutAround(canvas, selectedNode) : false;
			if (!this.canFinishEditing(canvas, selectedNode)) return;
			if (resized && !layoutChanged) this.adapter.commitCanvasBatch(canvas, true, 'push');
			this.adapter.selectNode(canvas, selectedNode);

			if (await this.nextFrame(canvas)) clearVisiblePreviewSizerMinHeight(selectedNode);
		} finally {
			this.finishingNodeIds.delete(selectedNode.id);
		}
	}

	// Guard after every async boundary to avoid stale Canvas/node work.
	private canFinishEditing(canvas: Canvas, node: CanvasNode): boolean {
		return this.scheduler.canRun(canvas) && canvas.nodes.has(node.id) && !canvas.readonly;
	}

	private nextFrame(canvas: Canvas): Promise<boolean> {
		return new Promise((resolve) => {
			this.scheduler.scheduleAnimationFrame(() => resolve(true), canvas, () => resolve(false));
		});
	}

	// Build operation service with current settings each time settings may have changed.
	private getOperations(): NodeOperations {
		return new NodeOperations(
			this.adapter,
			new MindmapLayout(this.adapter, {
				rowGap: this.plugin.settings.rowGap,
				columnGap: this.plugin.settings.columnGap,
				rootBranchDirections: this.plugin.settings.rootBranchDirections,
			}),
			this.plugin.settings,
			{
				scheduleTimeout: (callback, delay, canvas) => this.scheduler.scheduleTimeout(callback, delay, canvas),
			},
		);
	}

	// Stop only shortcuts owned by My Mind; native Canvas shortcuts are otherwise left alone.
	private consume(event: KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
	}

}
