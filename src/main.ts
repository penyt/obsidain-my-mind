// Entrypoint of Obsidian plugin

//------------ import dependencies ------------
import { Plugin } from 'obsidian';
import { MindmapController } from './canvas/mindmap-controller';
import {
	DEFAULT_SETTINGS,
	MyMindSettingTab,
	MyMindSettings,
} from './settings';

//------------ main class of this plugin ------------
export default class MyMindPlugin extends Plugin {
	// will be set later
	settings!: MyMindSettings;
	private mindmapController!: MindmapController;

	async onload(): Promise<void> {
		await this.loadSettings();

		// initialize MindmapController
		this.mindmapController = new MindmapController(this);
		this.mindmapController.load();

		// add commands, will appear in Command Palette, can be assigned to a hotkey
		this.addCommand({
			id: 'toggle-mindmap-mode',
			name: 'Toggle mindmap mode for current canvas',
			checkCallback: (checking) => {
				if (checking) return this.mindmapController.hasCurrentCanvas();
				void this.mindmapController.toggleCurrentCanvas();
				return true;
			},
		});
		this.addCommand({
			id: 'auto-layout-current-mindmap-canvas',
			name: 'Auto layout current mindmap canvas',
			checkCallback: (checking) => {
				if (checking) return this.mindmapController.isCurrentCanvasEnabled();
				return this.mindmapController.autoLayoutCurrentCanvas();
			},
		});
		this.addCommand({
			id: 'move-selected-branch-to-left',
			name: 'Move selected branch to left',
			callback: () => this.mindmapController.moveSelectedRootBranch('left'),
		});
		this.addCommand({
			id: 'move-selected-branch-to-right',
			name: 'Move selected branch to right',
			callback: () => this.mindmapController.moveSelectedRootBranch('right'),
		});

		// add plugin settings page
		this.addSettingTab(new MyMindSettingTab(this.app, this));
	}

	// load settings and migrate old data if needed
	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<MyMindSettings> & { subtreeDragMode?: 'always' | 'alt' | 'off' };
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			loaded,
		);
		if (typeof loaded.subtreeDrag === 'boolean') {
			this.settings.subtreeDrag = loaded.subtreeDrag;
		} else if (loaded.subtreeDragMode) {
			this.settings.subtreeDrag = loaded.subtreeDragMode !== 'off';
		}
	}

	// save settings to data.json
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// called by settings UI after color changes
	applyFirstLevelColorsToCurrentCanvas(): void {
		this.mindmapController.applyFirstLevelColorsToCurrentCanvas();
	}

	// called by settings UI after root direction changes
	refreshRootBranchDirections(): void {
		this.mindmapController.refreshRootBranchDirections();
	}
}
