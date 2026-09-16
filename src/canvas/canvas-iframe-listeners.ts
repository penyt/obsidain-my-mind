//Lifecycle-safe listeners for Canvas editor iframes

//------------ import dependencies ------------
import { getEditorTextSnapshot } from './mindmap-controller-helpers';
import { Canvas, CanvasNode } from './canvas-types';

// Tracks all listeners attached to one iframe.
interface IframeListenerState {
	canvas: Canvas;
	node: CanvasNode;
	iframe: HTMLIFrameElement;
	document: Document | null;
	loadListener: () => void;
	keydownListener: (event: KeyboardEvent) => void;
	focusoutListener: () => void;
}

/**
 * Manages listeners for Canvas text editors, which Obsidian renders inside
 * iframes. Iframes can appear, disappear, or reload while editing, so every
 * listener is paired with an explicit detach path.
 */
//------------ iframe listener service ------------
export class CanvasIframeListeners {
	private readonly iframeStates = new Map<HTMLIFrameElement, IframeListenerState>();
	private iframeObserver: MutationObserver | null = null;

	constructor(
		private readonly onKeydown: (event: KeyboardEvent) => void,
		private readonly onFocusout: (canvas: Canvas, node: CanvasNode, textSnapshot: string | null) => void,
	) {}

	/** Scan existing editor iframes once, then observe future iframe changes. */
	attachCanvas(canvas: Canvas): void {
		this.cleanupDisconnectedIframes();
		this.scanCanvasIframes(canvas);
		this.ensureIframeObserver(canvas);
	}

	/** Remove MutationObserver, iframe load handlers, and document listeners. */
	detachCanvas(): void {
		this.iframeObserver?.disconnect();
		this.iframeObserver = null;
		for (const iframe of Array.from(this.iframeStates.keys())) {
			this.detachIframe(iframe);
		}
	}

	// Observe DOM changes instead of polling for editor iframes.
	private ensureIframeObserver(canvas: Canvas): void {
		if (this.iframeObserver) return;
		const root = canvas.canvasEl ?? canvas.wrapperEl;
		if (!root) return;

		this.iframeObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.removedNodes)) {
					this.detachRemovedIframes(node);
				}
				for (const node of Array.from(mutation.addedNodes)) {
					this.attachAddedIframes(canvas, node);
				}
			}
			this.cleanupDisconnectedIframes();
		});
		this.iframeObserver.observe(root, { childList: true, subtree: true });
	}

	// Attach to editors that already exist when the Canvas becomes active.
	private scanCanvasIframes(canvas: Canvas): void {
		for (const node of canvas.nodes.values()) {
			const iframe = node.nodeEl?.querySelector('iframe');
			if (iframe?.instanceOf(HTMLIFrameElement)) this.attachIframe(canvas, node, iframe);
		}
	}

	private attachAddedIframes(canvas: Canvas, node: Node): void {
		if (!node.instanceOf(Element)) return;
		const iframes = node.instanceOf(HTMLIFrameElement)
			? [node]
			: Array.from(node.querySelectorAll('iframe')).filter((iframe): iframe is HTMLIFrameElement => iframe.instanceOf(HTMLIFrameElement));

		for (const iframe of iframes) {
			const canvasNode = this.getNodeForIframe(canvas, iframe);
			if (canvasNode) this.attachIframe(canvas, canvasNode, iframe);
		}
	}

	// Attach load/document listeners for a Canvas text editor iframe.
	private attachIframe(canvas: Canvas, node: CanvasNode, iframe: HTMLIFrameElement): void {
		const existingState = this.iframeStates.get(iframe);
		if (existingState) {
			existingState.node = node;
			this.bindIframeDocument(existingState);
			return;
		}

		const state: IframeListenerState = {
			canvas,
			node,
			iframe,
			document: null,
			loadListener: () => this.bindIframeDocument(state),
			keydownListener: (event) => this.onKeydown(event),
			focusoutListener: () => {
				if (!state.document) return;
				const textSnapshot = getEditorTextSnapshot(state.document);
				this.onFocusout(state.canvas, state.node, textSnapshot);
			},
		};
		iframe.addEventListener('load', state.loadListener);
		this.iframeStates.set(iframe, state);
		this.bindIframeDocument(state);
	}

	/** Rebind when an iframe reloads and exposes a new contentDocument. */
	private bindIframeDocument(state: IframeListenerState): void {
		const iframeDocument = state.iframe.contentDocument;
		if (!iframeDocument || state.document === iframeDocument) return;

		this.detachIframeDocument(state);
		iframeDocument.addEventListener('keydown', state.keydownListener, { capture: true });
		iframeDocument.addEventListener('focusout', state.focusoutListener, { capture: true });
		state.document = iframeDocument;
	}

	// Remove listeners from the current iframe document before rebinding or cleanup.
	private detachIframeDocument(state: IframeListenerState): void {
		if (!state.document) return;
		state.document.removeEventListener('keydown', state.keydownListener, { capture: true });
		state.document.removeEventListener('focusout', state.focusoutListener, { capture: true });
		state.document = null;
	}

	private detachRemovedIframes(node: Node): void {
		if (!node.instanceOf(Element)) return;
		const iframes = node.instanceOf(HTMLIFrameElement)
			? [node]
			: Array.from(node.querySelectorAll('iframe')).filter((iframe): iframe is HTMLIFrameElement => iframe.instanceOf(HTMLIFrameElement));
		for (const iframe of iframes) {
			this.detachIframe(iframe);
		}
	}

	private detachIframe(iframe: HTMLIFrameElement): void {
		const state = this.iframeStates.get(iframe);
		if (!state) return;

		this.detachIframeDocument(state);
		iframe.removeEventListener('load', state.loadListener);
		this.iframeStates.delete(iframe);
	}

	// Safety cleanup for iframes removed outside the MutationObserver path.
	private cleanupDisconnectedIframes(): void {
		for (const iframe of Array.from(this.iframeStates.keys())) {
			if (!iframe.isConnected) this.detachIframe(iframe);
		}
	}

	private getNodeForIframe(canvas: Canvas, iframe: HTMLIFrameElement): CanvasNode | null {
		for (const node of canvas.nodes.values()) {
			if (node.nodeEl?.contains(iframe)) return node;
		}
		return null;
	}
}
