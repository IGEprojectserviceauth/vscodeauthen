/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { IIdentityProvider, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ICompressedTreeElement, ICompressedTreeNode } from 'vs/base/browser/ui/tree/compressedObjectTreeModel';
import { ICompressibleTreeRenderer } from 'vs/base/browser/ui/tree/objectTree';
import { ITreeNode, ITreeSorter } from 'vs/base/browser/ui/tree/tree';
import { assertNever } from 'vs/base/common/assert';
import { Codicon } from 'vs/base/common/codicons';
import { memoize } from 'vs/base/common/decorators';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, DisposableStore, MutableDisposable } from 'vs/base/common/lifecycle';
import { IObservable, autorun, observableValue } from 'vs/base/common/observable';
import { IPrefixTreeNode } from 'vs/base/common/prefixTree';
import { basenameOrAuthority } from 'vs/base/common/resources';
import { ThemeIcon } from 'vs/base/common/themables';
import { URI } from 'vs/base/common/uri';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { localize, localize2 } from 'vs/nls';
import { MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { EditorOpenSource, TextEditorSelectionRevealType } from 'vs/platform/editor/common/editor';
import { FileKind } from 'vs/platform/files/common/files';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ILabelService } from 'vs/platform/label/common/label';
import { WorkbenchCompressibleObjectTree } from 'vs/platform/list/browser/listService';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IResourceLabel, ResourceLabels } from 'vs/workbench/browser/labels';
import { IViewPaneOptions, ViewAction, ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { testingStatesToIcons, testingWasCovered } from 'vs/workbench/contrib/testing/browser/icons';
import { CoverageBarSource, ManagedTestCoverageBars } from 'vs/workbench/contrib/testing/browser/testCoverageBars';
import { TestCommandId, Testing } from 'vs/workbench/contrib/testing/common/constants';
import { ComputedFileCoverage, FileCoverage, TestCoverage, getTotalCoveragePercent } from 'vs/workbench/contrib/testing/common/testCoverage';
import { ITestCoverageService } from 'vs/workbench/contrib/testing/common/testCoverageService';
import { CoverageDetails, DetailType, ICoveredCount, IFunctionCoverage, TestResultState } from 'vs/workbench/contrib/testing/common/testTypes';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from 'vs/workbench/services/editor/common/editorService';

const enum CoverageSortOrder {
	Coverage,
	Location,
	Name,
}

export class TestCoverageView extends ViewPane {
	private readonly tree = new MutableDisposable<TestCoverageTree>();
	public readonly sortOrder = observableValue('sortOrder', CoverageSortOrder.Location);

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ITestCoverageService private readonly coverageService: ITestCoverageService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));

		this._register(autorun(reader => {
			const coverage = this.coverageService.selected.read(reader);
			if (coverage) {
				const t = (this.tree.value ??= this.instantiationService.createInstance(TestCoverageTree, container, labels, this.sortOrder));
				t.setInput(coverage);
			} else {
				this.tree.clear();
			}
		}));
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree.value?.layout(height, width);
	}
}

let fnNodeId = 0;

class FunctionCoverageNode {
	public readonly id = String(fnNodeId++);
	public readonly containedDetails = new Set<CoverageDetails>();
	public readonly children: FunctionCoverageNode[] = [];

	public get hits() {
		return this.data.count;
	}

	public get label() {
		return this.data.name;
	}

	public get location() {
		return this.data.location;
	}

	public get tpc() {
		const attr = this.attributableCoverage();
		return attr && getTotalCoveragePercent(attr.statement, attr.branch, undefined);
	}

	constructor(
		public readonly uri: URI,
		private readonly data: IFunctionCoverage,
		details: readonly CoverageDetails[],
	) {
		if (data.location instanceof Range) {
			for (const detail of details) {
				if (this.contains(detail.location)) {
					this.containedDetails.add(detail);
				}
			}
		}
	}

	/** Gets whether this function has a defined range and contains the given range. */
	public contains(location: Range | Position) {
		const own = this.data.location;
		return own instanceof Range && (location instanceof Range ? own.containsRange(location) : own.containsPosition(location));
	}

	/**
	 * If the function defines a range, we can look at statements within the
	 * function to get total coverage for the function, rather than a boolean
	 * yes/no.
	 */
	@memoize
	public attributableCoverage() {
		const { location, count } = this.data;
		if (!(location instanceof Range) || !count) {
			return;
		}

		const statement: ICoveredCount = { covered: 0, total: 0 };
		const branch: ICoveredCount = { covered: 0, total: 0 };
		for (const detail of this.containedDetails) {
			if (detail.type !== DetailType.Statement) {
				continue;
			}

			statement.covered += detail.count ? 1 : 0;
			statement.total++;
			if (detail.branches) {
				for (const { count } of detail.branches) {
					branch.covered += count ? 1 : 0;
					branch.total++;
				}
			}
		}

		return { statement, branch } satisfies CoverageBarSource;
	}
}

class RevealUncoveredFunctions {
	public readonly id = String(fnNodeId++);

	public get label() {
		return localize('functionsWithoutCoverage', "{0} functions without coverage...", this.n);
	}

	constructor(public readonly n: number) { }
}

class LoadingDetails {
	public readonly id = String(fnNodeId++);
	public readonly label = localize('loadingCoverageDetails', "Loading Coverage Details...");
}

/** Type of nodes returned from {@link TestCoverage}. Note: value is *always* defined. */
type TestCoverageFileNode = IPrefixTreeNode<ComputedFileCoverage | FileCoverage>;
type CoverageTreeElement = TestCoverageFileNode | FunctionCoverageNode | LoadingDetails | RevealUncoveredFunctions;

const isFileCoverage = (c: CoverageTreeElement): c is TestCoverageFileNode => typeof c === 'object' && 'value' in c;
const isFunctionCoverage = (c: CoverageTreeElement): c is FunctionCoverageNode => c instanceof FunctionCoverageNode;
const shouldShowFunctionDetailsOnExpand = (c: CoverageTreeElement): c is IPrefixTreeNode<FileCoverage> =>
	isFileCoverage(c) && c.value instanceof FileCoverage && !!c.value.function?.total;

class TestCoverageTree extends Disposable {
	private readonly tree: WorkbenchCompressibleObjectTree<CoverageTreeElement, void>;

	constructor(
		container: HTMLElement,
		labels: ResourceLabels,
		sortOrder: IObservable<CoverageSortOrder>,
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService editorService: IEditorService,
	) {
		super();

		this.tree = <WorkbenchCompressibleObjectTree<CoverageTreeElement, void>>instantiationService.createInstance(
			WorkbenchCompressibleObjectTree,
			'TestCoverageView',
			container,
			new TestCoverageTreeListDelegate(),
			[
				instantiationService.createInstance(FileCoverageRenderer, labels),
				instantiationService.createInstance(FunctionCoverageRenderer),
				instantiationService.createInstance(BasicRenderer),
			],
			{
				expandOnlyOnTwistieClick: true,
				sorter: new Sorter(sortOrder),
				keyboardNavigationLabelProvider: {
					getCompressedNodeKeyboardNavigationLabel(elements: CoverageTreeElement[]) {
						return elements.map(e => this.getKeyboardNavigationLabel(e)).join('/');
					},
					getKeyboardNavigationLabel(e: CoverageTreeElement) {
						return isFileCoverage(e)
							? basenameOrAuthority(e.value!.uri)
							: e.label;
					},
				},
				accessibilityProvider: {
					getAriaLabel(element: CoverageTreeElement) {
						if (isFileCoverage(element)) {
							const name = basenameOrAuthority(element.value!.uri);
							return localize('testCoverageItemLabel', "{0} coverage: {0}%", name, (element.value!.tpc * 100).toFixed(2));
						} else {
							return element.label;
						}
					},
					getWidgetAriaLabel() {
						return localize('testCoverageTreeLabel', "Test Coverage Explorer");
					}
				},
				identityProvider: new TestCoverageIdentityProvider(),
			}
		);

		this._register(autorun(reader => {
			sortOrder.read(reader);
			this.tree.resort(null, true);
		}));

		this._register(this.tree);
		this._register(this.tree.onDidChangeCollapseState(e => {
			const el = e.node.element;
			if (!e.node.collapsed && !e.node.children.length && el && shouldShowFunctionDetailsOnExpand(el)) {
				if (el.value!.hasSynchronousDetails) {
					this.tree.setChildren(el, [{ element: new LoadingDetails(), incompressible: true }]);
				}

				el.value!.details().then(details => this.updateWithDetails(el, details));
			}
		}));
		this._register(this.tree.onDidOpen(e => {
			let resource: URI | undefined;
			let selection: Range | Position | undefined;
			if (e.element) {
				if (isFileCoverage(e.element) && !e.element.children?.size) {
					resource = e.element.value!.uri;
				} else if (isFunctionCoverage(e.element)) {
					resource = e.element.uri;
					selection = e.element.location;
				}
			}
			if (!resource) {
				return;
			}

			editorService.openEditor({
				resource,
				options: {
					selection: selection instanceof Position ? Range.fromPositions(selection, selection) : selection,
					revealIfOpened: true,
					selectionRevealType: TextEditorSelectionRevealType.NearTopIfOutsideViewport,
					preserveFocus: e.editorOptions.preserveFocus,
					pinned: e.editorOptions.pinned,
					source: EditorOpenSource.USER,
				},
			}, e.sideBySide ? SIDE_GROUP : ACTIVE_GROUP);
		}));
	}

	public setInput(coverage: TestCoverage) {
		const files = [];
		for (let node of coverage.tree.nodes) {
			// when showing initial children, only show from the first file or tee
			while (!(node.value instanceof FileCoverage) && node.children?.size === 1) {
				node = Iterable.first(node.children.values())!;
			}
			files.push(node);
		}

		const toChild = (file: TestCoverageFileNode): ICompressedTreeElement<CoverageTreeElement> => {
			const isFile = !file.children?.size;
			return {
				element: file,
				incompressible: isFile,
				collapsed: isFile,
				// directories can be expanded, and items with function info can be expanded
				collapsible: !isFile || !!file.value?.function?.total,
				children: file.children && Iterable.map(file.children?.values(), toChild)
			};
		};

		this.tree.setChildren(null, Iterable.map(files, toChild));
	}

	public layout(height: number, width: number) {
		this.tree.layout(height, width);
	}

	private updateWithDetails(el: IPrefixTreeNode<FileCoverage>, details: readonly CoverageDetails[]) {
		if (!this.tree.hasElement(el)) {
			return; // avoid any issues if the tree changes in the meanwhile
		}

		const functions: FunctionCoverageNode[] = [];
		for (const fn of details) {
			if (fn.type !== DetailType.Function) {
				continue;
			}

			let arr = functions;
			while (true) {
				const parent = arr.find(p => p.containedDetails.has(fn));
				if (parent) {
					arr = parent.children;
				} else {
					break;
				}
			}

			arr.push(new FunctionCoverageNode(el.value!.uri, fn, details));
		}

		const makeChild = (fn: FunctionCoverageNode): ICompressedTreeElement<CoverageTreeElement> => ({
			element: fn,
			incompressible: true,
			collapsed: true,
			collapsible: fn.children.length > 0,
			children: fn.children.map(makeChild)
		});

		this.tree.setChildren(el, functions.map(makeChild));
	}
}

class TestCoverageTreeListDelegate implements IListVirtualDelegate<CoverageTreeElement> {
	getHeight(element: CoverageTreeElement): number {
		return 22;
	}

	getTemplateId(element: CoverageTreeElement): string {
		if (isFileCoverage(element)) {
			return FileCoverageRenderer.ID;
		}
		if (isFunctionCoverage(element)) {
			return FunctionCoverageRenderer.ID;
		}
		if (element instanceof LoadingDetails || element instanceof RevealUncoveredFunctions) {
			return BasicRenderer.ID;
		}
		assertNever(element);
	}
}

class Sorter implements ITreeSorter<CoverageTreeElement> {
	constructor(private readonly order: IObservable<CoverageSortOrder>) { }
	compare(a: CoverageTreeElement, b: CoverageTreeElement): number {
		const order = this.order.get();
		if (isFileCoverage(a) && isFileCoverage(b)) {
			switch (order) {
				case CoverageSortOrder.Location:
				case CoverageSortOrder.Name:
					return a.value!.uri.toString().localeCompare(b.value!.uri.toString());
				case CoverageSortOrder.Coverage:
					return b.value!.tpc - a.value!.tpc;
			}
		} else if (isFunctionCoverage(a) && isFunctionCoverage(b)) {
			switch (order) {
				case CoverageSortOrder.Location:
					return Position.compare(
						a.location instanceof Range ? a.location.getStartPosition() : a.location,
						b.location instanceof Range ? b.location.getStartPosition() : b.location,
					);
				case CoverageSortOrder.Name:
					return a.label.localeCompare(b.label);
				case CoverageSortOrder.Coverage: {
					const attrA = a.tpc;
					const attrB = b.tpc;
					return (attrA !== undefined && attrB !== undefined && attrB - attrA)
						|| (+b.hits - +a.hits)
						|| a.label.localeCompare(b.label);
				}
			}
		} else {
			return 0;
		}
	}
}

interface FileTemplateData {
	container: HTMLElement;
	bars: ManagedTestCoverageBars;
	templateDisposables: DisposableStore;
	label: IResourceLabel;
}

class FileCoverageRenderer implements ICompressibleTreeRenderer<CoverageTreeElement, FuzzyScore, FileTemplateData> {
	public static readonly ID = 'F';
	public readonly templateId = FileCoverageRenderer.ID;

	constructor(
		private readonly labels: ResourceLabels,
		@ILabelService private readonly labelService: ILabelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	/** @inheritdoc */
	public renderTemplate(container: HTMLElement): FileTemplateData {
		const templateDisposables = new DisposableStore();
		container.classList.add('test-coverage-list-item');

		return {
			container,
			bars: templateDisposables.add(this.instantiationService.createInstance(ManagedTestCoverageBars, { compact: false, container })),
			label: templateDisposables.add(this.labels.create(container, {
				supportHighlights: true,
			})),
			templateDisposables,
		};
	}

	/** @inheritdoc */
	public renderElement(node: ITreeNode<CoverageTreeElement, FuzzyScore>, _index: number, templateData: FileTemplateData): void {
		this.doRender(node.element as TestCoverageFileNode, templateData, node.filterData);
	}

	/** @inheritdoc */
	public renderCompressedElements(node: ITreeNode<ICompressedTreeNode<CoverageTreeElement>, FuzzyScore>, _index: number, templateData: FileTemplateData): void {
		this.doRender(node.element.elements, templateData, node.filterData);
	}

	public disposeTemplate(templateData: FileTemplateData) {
		templateData.templateDisposables.dispose();
	}

	/** @inheritdoc */
	private doRender(element: CoverageTreeElement | CoverageTreeElement[], templateData: FileTemplateData, filterData: FuzzyScore | undefined) {
		const stat = (element instanceof Array ? element[element.length - 1] : element) as TestCoverageFileNode;
		const file = stat.value!;
		const name = element instanceof Array ? element.map(e => basenameOrAuthority((e as TestCoverageFileNode).value!.uri)) : basenameOrAuthority(file.uri);

		templateData.bars.setCoverageInfo(file);
		templateData.label.setResource({ resource: file.uri, name }, {
			fileKind: stat.children?.size ? FileKind.FOLDER : FileKind.FILE,
			matches: createMatches(filterData),
			separator: this.labelService.getSeparator(file.uri.scheme, file.uri.authority),
			extraClasses: ['test-coverage-list-item-label'],
		});
	}
}

interface FunctionTemplateData {
	container: HTMLElement;
	bars: ManagedTestCoverageBars;
	templateDisposables: DisposableStore;
	icon: HTMLElement;
	label: HTMLElement;
}

class FunctionCoverageRenderer implements ICompressibleTreeRenderer<CoverageTreeElement, FuzzyScore, FunctionTemplateData> {
	public static readonly ID = 'N';
	public readonly templateId = FunctionCoverageRenderer.ID;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	/** @inheritdoc */
	public renderTemplate(container: HTMLElement): FunctionTemplateData {
		const templateDisposables = new DisposableStore();
		container.classList.add('test-coverage-list-item');
		const icon = dom.append(container, dom.$('.state'));
		const label = dom.append(container, dom.$('.name'));

		return {
			container,
			bars: templateDisposables.add(this.instantiationService.createInstance(ManagedTestCoverageBars, { compact: false, container })),
			templateDisposables,
			icon,
			label,
		};
	}

	/** @inheritdoc */
	public renderElement(node: ITreeNode<CoverageTreeElement, FuzzyScore>, _index: number, templateData: FunctionTemplateData): void {
		this.doRender(node.element as FunctionCoverageNode, templateData, node.filterData);
	}

	/** @inheritdoc */
	public renderCompressedElements(node: ITreeNode<ICompressedTreeNode<CoverageTreeElement>, FuzzyScore>, _index: number, templateData: FunctionTemplateData): void {
		this.doRender(node.element.elements[node.element.elements.length - 1] as FunctionCoverageNode, templateData, node.filterData);
	}

	public disposeTemplate(templateData: FunctionTemplateData) {
		templateData.templateDisposables.dispose();
	}

	/** @inheritdoc */
	private doRender(element: FunctionCoverageNode, templateData: FunctionTemplateData, _filterData: FuzzyScore | undefined) {
		const covered = !!element.hits;
		const icon = covered ? testingWasCovered : testingStatesToIcons.get(TestResultState.Unset);
		templateData.container.classList.toggle('not-covered', !covered);
		templateData.icon.className = `computed-state ${ThemeIcon.asClassName(icon!)}`;
		templateData.label.innerText = element.label;
		templateData.bars.setCoverageInfo(element.attributableCoverage());
	}
}

class BasicRenderer implements ICompressibleTreeRenderer<CoverageTreeElement, FuzzyScore, HTMLElement> {
	public static readonly ID = 'B';
	public readonly templateId = BasicRenderer.ID;

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<CoverageTreeElement>, FuzzyScore>, _index: number, container: HTMLElement): void {
		this.renderInner(node.element.elements[node.element.elements.length - 1], container);
	}

	renderTemplate(container: HTMLElement): HTMLElement {
		return container;
	}

	renderElement(node: ITreeNode<CoverageTreeElement, FuzzyScore>, index: number, container: HTMLElement): void {
		this.renderInner(node.element, container);
	}

	disposeTemplate(): void {
		// no-op
	}

	private renderInner(element: CoverageTreeElement, container: HTMLElement) {
		container.innerText = (element as RevealUncoveredFunctions | LoadingDetails).label;
	}
}

class TestCoverageIdentityProvider implements IIdentityProvider<CoverageTreeElement> {
	public getId(element: CoverageTreeElement) {
		return isFileCoverage(element)
			? element.value!.uri.toString()
			: element.id;
	}
}

registerAction2(class TestCoverageChangeSortingAction extends ViewAction<TestCoverageView> {
	constructor() {
		super({
			id: TestCommandId.CoverageViewChangeSorting,
			viewId: Testing.CoverageViewId,
			title: localize2('testing.changeCoverageSort', 'Change Sort Order'),
			icon: Codicon.sortPrecedence,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', Testing.CoverageViewId),
				group: 'navigation',
			}
		});
	}

	override runInView(accessor: ServicesAccessor, view: TestCoverageView) {
		type Item = IQuickPickItem & { value: CoverageSortOrder };

		const disposables = new DisposableStore();
		const quickInput = disposables.add(accessor.get(IQuickInputService).createQuickPick<Item>());
		const items: Item[] = [
			{ label: localize('testing.coverageSortByLocation', 'Sort by Location'), value: CoverageSortOrder.Location, description: localize('testing.coverageSortByLocationDescription', 'Files are sorted alphabetically, functions are sorted by position') },
			{ label: localize('testing.coverageSortByCoverage', 'Sort by Coverage'), value: CoverageSortOrder.Coverage, description: localize('testing.coverageSortByCoverageDescription', 'Files and functions are sorted by total coverage') },
			{ label: localize('testing.coverageSortByName', 'Sort by Name'), value: CoverageSortOrder.Name, description: localize('testing.coverageSortByNameDescription', 'Files and functions are sorted alphabetically') },
		];

		quickInput.placeholder = localize('testing.coverageSortPlaceholder', 'Sort the Test Coverage view...');
		quickInput.items = items;
		quickInput.show();
		quickInput.onDidHide(() => quickInput.dispose());
		quickInput.onDidAccept(() => {
			const picked = quickInput.selectedItems[0]?.value;
			if (picked !== undefined) {
				view.sortOrder.set(picked, undefined);
				quickInput.dispose();
			}
		});
	}
});
