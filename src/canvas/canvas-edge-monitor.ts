//requestSave-based monitor for root branch edge-side changes

//------------ import dependencies ------------
import { CanvasAdapter, RequestSaveHookHandle } from './canvas-adapter';
import { Canvas } from './canvas-types';
import { CanvasWorkScheduler } from './canvas-work-scheduler';
import {
	EdgeEndpointSnapshot,
	getEdgeChangeSignature,
	getEdgeEndpointChanges,
	getEdgeEndpointSnapshot,
	hasTransientEndpoint,
	isCanvasConnecting,
	isCanvasConnected,
	isRootMainBranchSideChange,
	isSelfChange,
} from './mindmap-controller-helpers';

//------------ constants ------------
const EDGE_MONITOR_MAX_WAIT_MS = 1500;
const EDGE_MONITOR_RETRY_MS = 50;

// Runtime state for one hooked Canvas.
interface EdgeMonitorState {
	canvas: Canvas;
	hook: RequestSaveHookHandle;
	lastSnapshot: Map<string, EdgeEndpointSnapshot>;
	selfChanges: Set<string>;
	pendingEvaluation: number | null;
	startedAt: number | null;
	isApplying: boolean;
	disabled: boolean;
}

/**
 * Watches root-branch edge side changes without polling.
 * Canvas reconnect operations eventually call requestSave(), so we hook that
 * method, diff edge endpoints, and relayout only after a stable side change.
 */
//------------ edge monitor service ------------
export class CanvasEdgeMonitor {
	private readonly edgeMonitors = new WeakMap<Canvas, EdgeMonitorState>();
	private readonly edgeMonitorCleanups = new Map<Canvas, () => void>();

	constructor(
		private readonly adapter: CanvasAdapter,
		private readonly scheduler: CanvasWorkScheduler,
		private readonly autoLayout: (canvas: Canvas, historyMode: 'push' | 'replace') => boolean,
	) {}

	/** Attach one requestSave hook per Canvas. Repeated enables must not nest wrappers. */
	ensure(canvas: Canvas): void {
		if (this.edgeMonitors.has(canvas)) return;

		const state = {} as EdgeMonitorState;
		const hook = this.adapter.hookRequestSave(canvas, () => {
			if (!state.disabled) this.scheduleEvaluation(state);
		});
		if (!hook) return;

		Object.assign(state, {
			canvas,
			hook,
			lastSnapshot: getEdgeEndpointSnapshot(canvas),
			selfChanges: new Set<string>(),
			pendingEvaluation: null,
			startedAt: null,
			isApplying: false,
			disabled: false,
		});
		this.edgeMonitors.set(canvas, state);
		this.edgeMonitorCleanups.set(canvas, () => this.disable(canvas));
	}

	/** Disable monitoring and restore requestSave if our wrapper is still installed. */
	disable(canvas: Canvas): boolean {
		const state = this.edgeMonitors.get(canvas);
		if (!state) return false;
		state.disabled = true;
		if (state.pendingEvaluation !== null) this.scheduler.cancelScheduledTimeout(state.pendingEvaluation);
		state.hook.detach();
		this.edgeMonitors.delete(canvas);
		this.edgeMonitorCleanups.delete(canvas);
		return true;
	}

	// Called on unload or global detach.
	disableAll(): void {
		for (const cleanup of Array.from(this.edgeMonitorCleanups.values())) cleanup();
		this.edgeMonitorCleanups.clear();
	}

	// Remove hooks for Canvas DOM instances that disappeared.
	cleanupDetached(): void {
		for (const canvas of Array.from(this.edgeMonitorCleanups.keys())) {
			if (!isCanvasConnected(canvas)) this.disable(canvas);
		}
	}

	/**
	 * Record plugin-originated endpoint changes so the next requestSave diff does
	 * not interpret our own layout/side updates as user reconnections.
	 */
	recordSelfChanges(canvas: Canvas, beforeSnapshot: Map<string, EdgeEndpointSnapshot>): void {
		const state = this.edgeMonitors.get(canvas);
		if (!state) return;

		const afterSnapshot = getEdgeEndpointSnapshot(canvas);
		for (const change of getEdgeEndpointChanges(beforeSnapshot, afterSnapshot)) {
			state.selfChanges.add(getEdgeChangeSignature(change));
		}
		state.lastSnapshot = afterSnapshot;
	}

	// Debounce requestSave bursts while Canvas finishes reconnecting edges.
	private scheduleEvaluation(state: EdgeMonitorState): void {
		if (state.pendingEvaluation !== null) this.scheduler.cancelScheduledTimeout(state.pendingEvaluation);
		state.startedAt ??= Date.now();
		state.pendingEvaluation = this.scheduler.scheduleTimeout(() => {
			state.pendingEvaluation = null;
			this.evaluateSnapshot(state);
		}, EDGE_MONITOR_RETRY_MS, state.canvas);
	}

	// Compare snapshots and relayout only for meaningful root-branch side changes.
	private evaluateSnapshot(state: EdgeMonitorState): void {
		if (isCanvasConnecting(state.canvas)) {
			const elapsedMs = Date.now() - (state.startedAt ?? Date.now());
			if (elapsedMs < EDGE_MONITOR_MAX_WAIT_MS) {
				this.scheduleEvaluation(state);
				return;
			}
			state.startedAt = null;
			return;
		}

		state.startedAt = null;
		const currentSnapshot = getEdgeEndpointSnapshot(state.canvas);
		const changes = getEdgeEndpointChanges(state.lastSnapshot, currentSnapshot)
			.filter((change) => !isSelfChange(state.selfChanges, change));
		if (changes.length === 0) {
			state.lastSnapshot = currentSnapshot;
			return;
		}
		if (changes.some((change) => hasTransientEndpoint(state.canvas, change))) return;

		const rootSideChanges = changes.filter((change) => isRootMainBranchSideChange(state.canvas, this.adapter, change));
		state.lastSnapshot = currentSnapshot;
		if (rootSideChanges.length === 0 || state.isApplying) return;

		state.isApplying = true;
		try {
			const beforeLayout = getEdgeEndpointSnapshot(state.canvas);
			this.autoLayout(state.canvas, 'replace');
			this.recordSelfChanges(state.canvas, beforeLayout);
		} finally {
			state.isApplying = false;
		}
	}
}
