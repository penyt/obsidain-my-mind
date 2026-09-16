//Settings types, defaults, and Settings tab UI

//------------ import dependencies ------------
import { App, PluginSettingTab, Setting, SettingGroup } from 'obsidian';
import MyMindPlugin from './main';

//------------ setting definition types ------------
// a setting or a group
type SettingDefinitionItem = SettingDefinition | SettingDefinitionGroup;

// a setting include: name, description, render function
type SettingDefinition = {
	name: string;
	desc?: string;
	render: (setting: Setting) => void;
};

// a group
type SettingDefinitionGroup = {
	type: 'group';
	heading: string;
	items: SettingDefinitionItem[];
};

// Vibe
// consider as a PluginSettingTab with an update()
type SettingTabWithUpdate = PluginSettingTab & {
	update?: () => void;
};

//------------ persisted plugin settings ------------
// settings value
export interface MyMindSettings {
	mindmapEnabledByCanvasPath: Record<string, boolean>;
	autoColorFirstLevel: boolean;
	autoEditNewNodes: boolean;
	zoomToNewNode: boolean;
	firstLevelColors: string[];
	subtreeDrag: boolean;
	autoLayoutSiblings: boolean;
	rootBranchDirections: boolean;
	useArrowNavigation: boolean;
	shiftArrowNudgeDistance: number;
	rowGap: number;
	columnGap: number;
	newNodeWidth: number;
	newNodeHeight: number;
	editDelayMs: number;
}

//------------ default setting values ------------
export const DEFAULT_SETTINGS: MyMindSettings = {
	mindmapEnabledByCanvasPath: {},
	autoColorFirstLevel: true,
	autoEditNewNodes: true,
	zoomToNewNode: false,
	// Canvas colors: https://docs.obsidian.md/Reference/CSS+variables/Plugins/Canvas
	firstLevelColors: ['1', '2', '3', '4', '5', '6'],
	subtreeDrag: true,
	autoLayoutSiblings: true,
	rootBranchDirections: true,
	useArrowNavigation: true,
	shiftArrowNudgeDistance: 10,
	rowGap: 50,
	columnGap: 100,
	newNodeWidth: 120,
	newNodeHeight: 52,
	editDelayMs: 50,
};

//------------ settings tab renderer ------------
export class MyMindSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: MyMindPlugin) {
		super(app, plugin);
	}

	// Obsidian 1.13+ uses declarative settings definitions.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.supportsDeclarativeSettings() ? this.getDefinitions() : [];
	}

	// Fallback renderer for older Obsidian versions without declarative update().
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const definition of this.getDefinitions()) {
			this.renderFallbackDefinition(containerEl, definition);
		}
	}

	// core of the settings 
	private getDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Keyboard', // group 'Keyboard' (2)
				items: [
					{
						name: 'Use Arrow keys to navigate',
						desc: 'Use plain Arrow keys for mindmap navigation. This replaces Canvas native Arrow-key node movement and enables Shift + Arrow node movement. Default: on.',
						render: (setting) => this.renderUseArrowNavigation(setting),
					},
					{
						name: 'Shift + Arrow move distance',
						desc: `Canvas-coordinate pixels to move selected nodes when Arrow navigation is enabled. Default: ${DEFAULT_SETTINGS.shiftArrowNudgeDistance}.`,
						render: (setting) => this.renderShiftArrowNudgeDistance(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Node creation', // group 'Node creation' (2)
				items: [
					{
						name: 'Edit new nodes automatically',
						desc: 'Start editing immediately after creating a child or sibling node. Default: on.',
						render: (setting) => this.renderAutoEditNewNodes(setting),
					},
					{
						name: 'Zoom to new node',
						desc: 'Zoom to the newly created node after tab or enter. Default: off.',
						render: (setting) => this.renderZoomToNewNode(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Colors', // group 'Colors' (2)
				items: [
					{
						name: 'Auto color first-level nodes',
						desc: 'Apply canvas colors 1–6 to direct children of each root node. Default: on.',
						render: (setting) => this.renderAutoColorFirstLevel(setting),
					},
					{
						name: 'First-level branch colors',
						desc: `Comma-separated canvas colors. Use 1–6 or hex colors like #ff8800. Default: ${DEFAULT_SETTINGS.firstLevelColors.join(', ')}.`,
						render: (setting) => this.renderFirstLevelColors(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Layout',  // group 'Layout' (3)
				items: [
					{
						name: 'Subtree drag',
						desc: 'Move descendants together when dragging a selected node. Default: on.',
						render: (setting) => this.renderSubtreeDrag(setting),
					},
					{
						name: 'Auto layout siblings',
						desc: 'Rebalance nodes with the same parent after creating a child or sibling node. Default: on.',
						render: (setting) => this.renderAutoLayoutSiblings(setting),
					},
					{
						name: 'Root branch direction',
						desc: 'Use the root connection side to expand first-level branches left or right, and show branch direction actions in the node menu. Default: on.',
						render: (setting) => this.renderRootBranchDirections(setting),
					},
				],
			},
			{
				type: 'group',
				heading: 'Spacing and size', // group 'Spacing and size' (4)
				items: [
					{
						name: 'Row gap',
						desc: `Vertical gap between sibling nodes. Default: ${DEFAULT_SETTINGS.rowGap}.`,
						render: (setting) => this.renderRowGap(setting),
					},
					{
						name: 'Column gap',
						desc: `Horizontal gap between a parent node and its children. Default: ${DEFAULT_SETTINGS.columnGap}.`,
						render: (setting) => this.renderColumnGap(setting),
					},
					{
						name: 'New node width',
						desc: `Default width for newly created mindmap text nodes. Default: ${DEFAULT_SETTINGS.newNodeWidth}.`,
						render: (setting) => this.renderNewNodeWidth(setting),
					},
					{
						name: 'New node height',
						desc: `Default height for newly created mindmap text nodes. After editing, nodes may grow to fit the current Obsidian theme line height. Default: ${DEFAULT_SETTINGS.newNodeHeight}.`,
						render: (setting) => this.renderNewNodeHeight(setting),
					},
				],
			},
		];
	}

	// Vibe
	// Render one definition for runtimes that do not support declarative settings (old Obsidian versions).
	private renderFallbackDefinition(containerEl: HTMLElement, definition: SettingDefinitionItem): void {
		if (isSettingGroup(definition)) {
			const wrapperEl = containerEl.createDiv({ cls: 'setting-group' });
			const group = new SettingGroup(wrapperEl).setHeading(definition.heading);
			for (const item of definition.items) {
				if (isSettingGroup(item)) {
					this.renderFallbackDefinition(containerEl, item);
					continue;
				}
				group.addSetting((setting) => this.renderSettingDefinition(setting, item));
			}
			return;
		}

		this.renderSettingDefinition(new Setting(containerEl), definition);
	}

	// set name, description, and render function   for a setting
	private renderSettingDefinition(setting: Setting, definition: SettingDefinition): void {
		setting.setName(definition.name);
		if (definition.desc) setting.setDesc(definition.desc);
		definition.render(setting);
	}

	// The official declarative Settings API exposes update() on newer runtimes.
	private supportsDeclarativeSettings(): boolean {
		return typeof (this as SettingTabWithUpdate).update === 'function';
	}

	// Re-render settings after toggles change disabled states or reset values.
	private refreshSettings(): void {
		const update = (this as SettingTabWithUpdate).update;
		if (typeof update === 'function') {
			update.call(this);
			return;
		}
		this.display();
	}

	//------------ individual setting renderers ------------
	private renderAutoColorFirstLevel(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.autoColorFirstLevel)
				.onChange(async (value) => {
					this.plugin.settings.autoColorFirstLevel = value;
					await this.plugin.saveSettings();
					this.plugin.applyFirstLevelColorsToCurrentCanvas();
					this.refreshSettings();
				}),
		);
	}

	private renderFirstLevelColors(setting: Setting): void {
		setting.addText((text) =>
			text
				.setDisabled(!this.plugin.settings.autoColorFirstLevel)
				.setPlaceholder('1, 2, 3, 4, 5, 6')
				.setValue(this.plugin.settings.firstLevelColors.join(', '))
				.onChange(async (value) => {
					const colors = value
						.split(',')
						.map((color) => color.trim())
						.filter((color) => color.length > 0);
					this.plugin.settings.firstLevelColors = colors.length > 0
						? colors
						: DEFAULT_SETTINGS.firstLevelColors;
					await this.plugin.saveSettings();
					this.plugin.applyFirstLevelColorsToCurrentCanvas();
				}),
		);
		this.addResetButton(setting, !this.plugin.settings.autoColorFirstLevel, async () => {
			this.plugin.settings.firstLevelColors = [...DEFAULT_SETTINGS.firstLevelColors];
			await this.plugin.saveSettings();
			this.plugin.applyFirstLevelColorsToCurrentCanvas();
			this.refreshSettings();
		});
	}

	private renderSubtreeDrag(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.subtreeDrag)
				.onChange(async (value) => {
					this.plugin.settings.subtreeDrag = value;
					await this.plugin.saveSettings();
				}),
		);
	}

	private renderAutoLayoutSiblings(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.autoLayoutSiblings)
				.onChange(async (value) => {
					this.plugin.settings.autoLayoutSiblings = value;
					await this.plugin.saveSettings();
				}),
		);
	}

	private renderRootBranchDirections(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.rootBranchDirections)
				.onChange(async (value) => {
					this.plugin.settings.rootBranchDirections = value;
					await this.plugin.saveSettings();
					this.plugin.refreshRootBranchDirections();
				}),
		);
	}

	private renderUseArrowNavigation(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.useArrowNavigation)
				.onChange(async (value) => {
					this.plugin.settings.useArrowNavigation = value;
					await this.plugin.saveSettings();
					this.refreshSettings();
				}),
		);
	}

	private renderShiftArrowNudgeDistance(setting: Setting): void {
		setting.addText((text) =>
			text
				.setDisabled(!this.plugin.settings.useArrowNavigation)
				.setValue(String(this.plugin.settings.shiftArrowNudgeDistance))
				.onChange(async (value) => {
					this.plugin.settings.shiftArrowNudgeDistance = toPositiveNumber(
						value,
						DEFAULT_SETTINGS.shiftArrowNudgeDistance,
					);
					await this.plugin.saveSettings();
				}),
		);
		this.addResetButton(setting, !this.plugin.settings.useArrowNavigation, async () => {
			this.plugin.settings.shiftArrowNudgeDistance = DEFAULT_SETTINGS.shiftArrowNudgeDistance;
			await this.plugin.saveSettings();
			this.refreshSettings();
		});
	}

	private renderAutoEditNewNodes(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.autoEditNewNodes)
				.onChange(async (value) => {
					this.plugin.settings.autoEditNewNodes = value;
					await this.plugin.saveSettings();
				}),
		);
	}

	private renderZoomToNewNode(setting: Setting): void {
		setting.addToggle((toggle) =>
			toggle
				.setValue(this.plugin.settings.zoomToNewNode)
				.onChange(async (value) => {
					this.plugin.settings.zoomToNewNode = value;
					await this.plugin.saveSettings();
				}),
		);
	}

	private renderRowGap(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(String(this.plugin.settings.rowGap)).onChange(async (value) => {
				this.plugin.settings.rowGap = toPositiveNumber(value, DEFAULT_SETTINGS.rowGap);
				await this.plugin.saveSettings();
			}),
		);
		this.addResetButton(setting, false, async () => {
			this.plugin.settings.rowGap = DEFAULT_SETTINGS.rowGap;
			await this.plugin.saveSettings();
			this.refreshSettings();
		});
	}

	private renderColumnGap(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(String(this.plugin.settings.columnGap)).onChange(async (value) => {
				this.plugin.settings.columnGap = toPositiveNumber(value, DEFAULT_SETTINGS.columnGap);
				await this.plugin.saveSettings();
			}),
		);
		this.addResetButton(setting, false, async () => {
			this.plugin.settings.columnGap = DEFAULT_SETTINGS.columnGap;
			await this.plugin.saveSettings();
			this.refreshSettings();
		});
	}

	private renderNewNodeWidth(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(String(this.plugin.settings.newNodeWidth)).onChange(async (value) => {
				this.plugin.settings.newNodeWidth = toPositiveNumber(value, DEFAULT_SETTINGS.newNodeWidth);
				await this.plugin.saveSettings();
			}),
		);
		this.addResetButton(setting, false, async () => {
			this.plugin.settings.newNodeWidth = DEFAULT_SETTINGS.newNodeWidth;
			await this.plugin.saveSettings();
			this.refreshSettings();
		});
	}

	private renderNewNodeHeight(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(String(this.plugin.settings.newNodeHeight)).onChange(async (value) => {
				this.plugin.settings.newNodeHeight = toPositiveNumber(value, DEFAULT_SETTINGS.newNodeHeight);
				await this.plugin.saveSettings();
			}),
		);
		this.addResetButton(setting, false, async () => {
			this.plugin.settings.newNodeHeight = DEFAULT_SETTINGS.newNodeHeight;
			await this.plugin.saveSettings();
			this.refreshSettings();
		});
	}

	// Small helper so numeric/text settings can restore default values.
	private addResetButton(setting: Setting, disabled: boolean, onReset: () => Promise<void>): void {
		setting.addButton((button) =>
			button
				.setButtonText('Reset')
				.setDisabled(disabled)
				.onClick(() => {
					void onReset();
				}),
		);
	}
}

//------------ utility functions ------------
function isSettingGroup(definition: SettingDefinitionItem): definition is SettingDefinitionGroup {
	return 'type' in definition && definition.type === 'group';
}

// Text inputs store numbers as strings; invalid values fall back safely.
function toPositiveNumber(value: string, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}
