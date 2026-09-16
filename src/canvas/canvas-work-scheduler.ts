//Centralized scheduler for delayed Canvas work

//------------ import dependencies ------------
import { Canvas } from './canvas-types';

// requestAnimationFrame state with optional cancellation callback.
interface PendingFrame {
	canvas: Canvas | null;
	onCancel?: () => void;
}

/**
 * Owns delayed work created by the controller.
 * This prevents stale timeouts/animation frames from touching a Canvas after the
 * plugin unloads, mindmap mode is disabled, or the Canvas is detached.
 */
//------------ scheduler service ------------
export class CanvasWorkScheduler {
	private readonly pendingTimeouts = new Map<number, Canvas | null>();
	private readonly pendingAnimationFrames = new Map<number, PendingFrame>();
	private readonly pointerListenerCleanups = new Set<() => void>();
	private disposed = false;

	constructor(private readonly isCanvasActive: (canvas: Canvas) => boolean) {}

	// Allow reuse after a previous dispose during controller reload.
	reset(): void {
		this.disposed = false;
	}

	/** Cancel all pending work. Returns false when already disposed. */
	dispose(): boolean {
		if (this.disposed) return false;
		this.disposed = true;
		this.cancelPendingWork();
		this.clearPointerListeners();
		return true;
	}

	// Schedule timeout and check Canvas/plugin state right before callback runs.
	scheduleTimeout(callback: () => void, delay: number, canvas: Canvas | null = null): number {
		const id = window.setTimeout(() => {
			this.pendingTimeouts.delete(id);
			if (!this.canRun(canvas)) return;
			callback();
		}, delay);
		this.pendingTimeouts.set(id, canvas);
		return id;
	}

	// Same as scheduleTimeout, but for animation-frame work.
	scheduleAnimationFrame(callback: () => void, canvas: Canvas | null = null, onCancel?: () => void): number {
		const id = window.requestAnimationFrame(() => {
			this.pendingAnimationFrames.delete(id);
			if (!this.canRun(canvas)) {
				onCancel?.();
				return;
			}
			callback();
		});
		this.pendingAnimationFrames.set(id, { canvas, onCancel });
		return id;
	}

	cancelScheduledTimeout(id: number): void {
		window.clearTimeout(id);
		this.pendingTimeouts.delete(id);
	}

	// Cancel all pending work, or only work tied to a specific Canvas.
	cancelPendingWork(canvas: Canvas | null = null): void {
		for (const [id, pendingCanvas] of Array.from(this.pendingTimeouts.entries())) {
			if (canvas && pendingCanvas !== canvas) continue;
			this.cancelScheduledTimeout(id);
		}

		for (const [id, frame] of Array.from(this.pendingAnimationFrames.entries())) {
			if (canvas && frame.canvas !== canvas) continue;
			window.cancelAnimationFrame(id);
			this.pendingAnimationFrames.delete(id);
			frame.onCancel?.();
		}
	}

	/** Check immediately before running delayed work. */
	canRun(canvas: Canvas | null): boolean {
		if (this.disposed) return false;
		if (!canvas) return true;
		return this.isCanvasActive(canvas);
	}

	/** Register pointerup/pointercancel as a pair; either event removes both. */
	registerPointerEndListeners(listener: EventListener): void {
		let cleanup = () => undefined;
		const wrappedListener: EventListener = (event) => {
			cleanup();
			listener(event);
		};
		cleanup = () => {
			activeDocument.removeEventListener('pointerup', wrappedListener, { capture: true });
			activeDocument.removeEventListener('pointercancel', wrappedListener, { capture: true });
			this.pointerListenerCleanups.delete(cleanup);
		};
		this.pointerListenerCleanups.add(cleanup);
		activeDocument.addEventListener('pointerup', wrappedListener, { once: true, capture: true });
		activeDocument.addEventListener('pointercancel', wrappedListener, { once: true, capture: true });
	}

	// Clear pointer listeners when drag flow ends or controller unloads.
	clearPointerListeners(): void {
		for (const cleanup of Array.from(this.pointerListenerCleanups)) cleanup();
		this.pointerListenerCleanups.clear();
	}
}
