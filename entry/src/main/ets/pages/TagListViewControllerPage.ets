// Port of TagListViewController.swift (+ .xib) — the sidebar drawer content. The TagListViewController
// component is mounted by SPNoteListViewControllerPage's SideBarContainer (hostedBy screen_note_list); the
// @Entry page wraps the same component so the screen can also be opened on its own (deep link / replay).
// Sections: system (All Notes / Trash / Settings), tags (header 'Tags' + Edit/Done, one row per Tag, only
// when tags exist), bottom (Untagged Notes).
import { router, LengthMetrics, ComponentContent, KeyboardAvoidMode } from '@kit.ArkUI';
import { emitter } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KeyCode } from '@kit.InputKit';
import { NoteStore } from '../common/NoteStore';
import { DefaultsKey, Options, OptionsEvent } from '../common/OptionsStore';
import { SessionStore } from '../common/SessionStore';
import { SPTracker } from '../common/Tracker';
import { Tag } from '../model/Tag';
import { NotesListFilter, NotesListFilterKind, SIMPLENOTE_TRASH_KEY, SIMPLENOTE_UNTAGGED_KEY } from '../model/NotesListFilter';
import { Value1TableViewCell } from '../components/Value1Cell';
import { SIDEBAR_VISIBLE_KEY } from '../components/SidebarContainer';
import { SPTagHeaderView } from '../components/TagHeader';
import { TagListViewCell, TagListViewCellDeletionSource } from '../components/TagListRow';

/// Movement (vp) after which a touch on a row is a swipe or scroll, not a tap
const TAP_SLOP: number = 10;
const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'TagList';

// HarmonyOS confirm dialog: a centred card with the question as its title and two text buttons
// (Cancel | Delete Tag) split by a vertical divider.
class TagDeleteSheetParams {
  title: string = '';
  onDelete: () => void = (): void => {};
  onCancel: () => void = (): void => {};
}

@Builder
function tagDeleteSheet(p: TagDeleteSheetParams) {
  Column() {
    Text(p.title)
      .fontSize($r('sys.float.Title_S'))
      .fontWeight(FontWeight.Bold)
      .fontColor($r('sys.color.font_primary'))
      .textAlign(TextAlign.Center)
      .width('100%')
      .padding({ left: 24, right: 24, top: 24, bottom: 16 })
    Row() {
      Button('Cancel', { type: ButtonType.Capsule, stateEffect: true })
        .id('tag_delete_cancel')
        .fontSize($r('sys.float.Body_L'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_emphasize'))
        .backgroundColor(Color.Transparent)
        .height(40)
        .layoutWeight(1)
        .onClick((): void => p.onCancel())
      Divider()
        .vertical(true)
        .height(24)
        .color($r('sys.color.comp_divider'))
      Button('Delete Tag', { type: ButtonType.Capsule, stateEffect: true })
        .id('tag_delete_confirm')
        .fontSize($r('sys.float.Body_L'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.warning'))
        .backgroundColor(Color.Transparent)
        .height(40)
        .layoutWeight(1)
        .onClick((): void => p.onDelete())
    }
    .width('100%')
    .padding({ left: 16, right: 16, bottom: 16 })
  }
  .width('100%')
  .backgroundColor($r('sys.color.comp_background_primary'))
  .borderRadius($r('sys.float.corner_radius_level16'))
}

/// The note list page owns the key events (its root sits on the focus chain, the sidebar does not) and
/// hands them to the sidebar through this while it shows: TagListViewController fills in handleKey.
export class TagListKeyController {
  handleKey: (keyCode: number) => boolean = (keyCode: number): boolean => false;
}

@Component
export struct TagListViewController {
  /// ResultsController<Tag> (sorted by index, or by name when SPAlphabeticalTagSortPref)
  @State tags: Tag[] = [];
  /// SPAppDelegate.selectedTag (writer: openNoteListForTagName)
  @StorageLink('selectedTag') selectedTag: string = '';
  /// isEditing (Edit / Done)
  @State isEditingTags: boolean = false;
  /// Reorder drag in progress: the dragged tag's key, its target offset in rows, and the row height (vp)
  @State dragKey: string = '';
  @State dragRows: number = 0;
  @State dragRowHeight: number = 0;
  /// SPAlphabeticalTagSortPref (mirrored into AppStorage from Options on appear / on change)
  @StorageProp('SPAlphabeticalTagSortPref') alphabetical: boolean = false;
  /// The tag store backing ResultsController<Tag>
  private tagStore: NoteStore = NoteStore.sharedManager();
  /// Set only by the standalone page: there is no list under this sidebar, so a selection must
  /// reveal the note list (the source sidebar always slides back to show it).
  showNoteList: (() => void) | null = null;
  /// Set by the note list page that hosts the sidebar; the standalone page handles its own key events.
  keys: TagListKeyController | null = null;
  /// tableView.indexPathForSelectedRow on the Settings row: keyboard traversal can rest there (iOS
  /// updateSelectionWhileTraversing skips it), which selects no filter.
  @State settingsHighlighted: boolean = false;
  @StorageProp('sidebarVisible') @Watch('sidebarVisibleDidChange') sidebarVisible: boolean = false;
  /// renameTag (by simperiumKey)
  @State @Watch('renameTagKeyDidChange') renameTagKey: string = '';
  /// The page's keyboard avoid mode before a rename switched it (undefined: not switched)
  private savedKeyboardAvoidMode: KeyboardAvoidMode | undefined = undefined;
  /// The renaming cell's current text, so a rename still pending when editing ends can be committed
  private renameDraft: string = '';
  private storeListener: () => void = (): void => {
    this.onStoreChange();
  };
  private sortListener: (data: emitter.EventData) => void = (data: emitter.EventData): void => {
    this.refreshSortDescriptorsAndPerformFetch();
  };

  aboutToAppear(): void {
    if (this.keys !== null) {
      (this.keys as TagListKeyController).handleKey = (keyCode: number): boolean => this.handleKey(keyCode);
    }
    this.syncAlphabeticalPref();
    this.performFetch();
    this.tagStore.addChangeListener(this.storeListener);
    emitter.on(OptionsEvent.ALPHABETICAL_TAG_SORT_PREFERENCE_CHANGED, this.sortListener);
  }

  aboutToDisappear(): void {
    this.tagStore.removeChangeListener(this.storeListener);
    emitter.off(OptionsEvent.ALPHABETICAL_TAG_SORT_PREFERENCE_CHANGED, this.sortListener);
    this.restoreKeyboardAvoidMode();
  }

  /// While a rename field has the keyboard, shrink the page above it and scroll the caret into view
  /// (UITableView keyboard insets). The default OFFSET lifts the whole page, so the sidebar's top
  /// rows slide under the status bar (T-0274).
  renameTagKeyDidChange(): void {
    if (this.renameTagKey.length > 0) {
      if (this.savedKeyboardAvoidMode === undefined) {
        this.savedKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
        this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE_WITH_CARET);
      }
    } else {
      this.restoreKeyboardAvoidMode();
    }
  }

  private restoreKeyboardAvoidMode(): void {
    if (this.savedKeyboardAvoidMode !== undefined) {
      this.getUIContext().setKeyboardAvoidMode(this.savedKeyboardAvoidMode);
      this.savedKeyboardAvoidMode = undefined;
    }
  }

  // MARK: - Results Controller

  private syncAlphabeticalPref(): void {
    AppStorage.setOrCreate<boolean>(DefaultsKey.ALPHABETICAL_TAG_SORT, Options.shared.alphabeticalTagSortPref);
  }

  private performFetch(): void {
    const all: Tag[] = this.tagStore.tags().slice();
    if (Options.shared.alphabeticalTagSortPref) {
      all.sort((a: Tag, b: Tag): number => a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()));
    }
    this.tags = all;
  }

  private refreshSortDescriptorsAndPerformFetch(): void {
    this.syncAlphabeticalPref();
    this.performFetch();
  }

  /// onDidChangeContent: section count changed, or the tag being renamed is gone -> stop editing.
  private onStoreChange(): void {
    const hadTags: boolean = this.tags.length > 0;
    this.performFetch();
    const renameGone: boolean = this.renameTagKey.length > 0 &&
      this.tags.findIndex((t: Tag): boolean => t.simperiumKey === this.renameTagKey) < 0;
    if (hadTags !== (this.tags.length > 0) || renameGone) {
      this.renameTagKey = '';
      this.setEditing(false);
    }
  }

  // MARK: - Button actions

  /// editTagsTap
  private editTagsTap(): void {
    const newState: boolean = !this.isEditingTags;
    if (newState) {
      SPTracker.trackTagEditorAccessed();
    }
    this.setEditing(newState);
  }

  private setEditing(editing: boolean): void {
    if (!editing) {
      // view.endEditing(true) before leaving edit mode: textFieldDidEndEditing saves the rename
      this.commitPendingRename();
      this.renameTagKey = '';
    }
    this.isEditingTags = editing;
  }

  // MARK: - Selection

  private isSelected(kind: NotesListFilterKind, tagName: string): boolean {
    if (this.settingsHighlighted) {
      return false;
    }
    const filter: NotesListFilter = NotesListFilter.fromSelectedTag(this.selectedTag);
    return filter.kind === kind && (kind !== NotesListFilterKind.TAG || filter.name === tagName);
  }

  // MARK: - Row Press Handlers

  /// A row click that ends a swipe (the left swipe that closes the sidebar) is not a selection: on iOS the
  /// table's tap recognizer fails once the touch moves, here the ListItem still reports onClick (T-0289).
  private touchStart: [number, number] = [0, 0];
  private touchMoved: boolean = false;

  private trackTouch(event: TouchEvent): void {
    const touch: TouchObject = event.touches[0];
    if (event.type === TouchType.Down) {
      this.touchStart = [touch.windowX, touch.windowY];
      this.touchMoved = false;
    } else if (event.type === TouchType.Move && (Math.abs(touch.windowX - this.touchStart[0]) > TAP_SLOP ||
      Math.abs(touch.windowY - this.touchStart[1]) > TAP_SLOP)) {
      this.touchMoved = true;
    }
  }

  private didSelectAllNotes(isTraversing: boolean): void {
    if (!isTraversing) {
      this.setEditing(false);
    }
    this.openNoteListForTagName(null, isTraversing);
  }

  private didSelectTrash(isTraversing: boolean): void {
    if (!isTraversing) {
      this.setEditing(false);
    }
    SPTracker.trackTrashViewed();
    this.openNoteListForTagName(SIMPLENOTE_TRASH_KEY, isTraversing);
  }

  /// Settings row -> SPAppDelegate.presentSettingsViewController.
  openSettings(): void {
    this.setEditing(false);
    router.pushUrl({ url: 'pages/SPSettingsViewControllerPage' }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'settings failed: %{public}s', e.message);
    });
  }

  private didSelectTag(tag: Tag, isTraversing: boolean): void {
    if (this.isEditingTags && !isTraversing) {
      SPTracker.trackTagRowRenamed();
      this.renameTag(tag);
    } else {
      SPTracker.trackListTagViewed();
      this.openNoteListForTagName(tag.name, isTraversing);
    }
  }

  private didSelectBottomRow(isTraversing: boolean): void {
    if (!isTraversing) {
      this.setEditing(false);
    }
    SPTracker.trackListUntaggedViewed();
    this.openNoteListForTagName(SIMPLENOTE_UNTAGGED_KEY, isTraversing);
  }

  private openNoteListForTagName(tagName: string | null, isTraversing: boolean): void {
    SessionStore.shared().selectedTag = tagName;
    if (!isTraversing) {
      AppStorage.setOrCreate<boolean>(SIDEBAR_VISIBLE_KEY, false);
      if (this.showNoteList !== null) {
        this.showNoteList();
      }
    }
  }

  // MARK: - Tag Actions

  private renameTag(tag: Tag): void {
    if (this.renameTagKey === tag.simperiumKey) {
      return;
    }
    // cell(for: renameTag)?.textField.endEditing(true): the previous rename is saved first
    this.commitPendingRename();
    this.renameDraft = tag.name;
    this.renameTagKey = tag.simperiumKey;
  }

  /// Commits the open rename field's text. endRename clears renameTagKey, so the cell's later onBlur is a no-op.
  private commitPendingRename(): void {
    const tag: Tag | undefined = this.tags.find((t: Tag): boolean => t.simperiumKey === this.renameTagKey);
    if (tag !== undefined) {
      this.endRename(tag, this.renameDraft);
    }
  }

  /// textFieldDidEndEditing: rename unless the new name already exists (then revert).
  private endRename(tag: Tag, newTagName: string): void {
    if (this.renameTagKey !== tag.simperiumKey) {
      return;
    }
    this.renameTagKey = '';
    const originalTagName: string = tag.name;
    const store: NoteStore = NoteStore.sharedManager();
    if (newTagName.length === 0 || store.tagExists(newTagName)) {
      this.performFetch();
      return;
    }
    store.editTag(tag, newTagName).then((): void => {
      if (this.selectedTag === originalTagName) {
        SessionStore.shared().selectedTag = newTagName;
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'rename failed: %{public}s', e.message);
    });
  }

  /// tagListViewCellShouldDeleteTag: confirmation sheet -> removeTag. The index is resolved at tap time
  /// (tableView.indexPath(for: cell)): a ForEach-captured index goes stale after a reorder.
  private confirmDeleteTag(tag: Tag, source: TagListViewCellDeletionSource): void {
    const index: number = this.tags.findIndex((t: Tag): boolean => t.simperiumKey === tag.simperiumKey);
    if (index < 0) {
      return;
    }
    const prompt = this.getUIContext().getPromptAction();
    const params: TagDeleteSheetParams = new TagDeleteSheetParams();
    params.title = `Are you sure you want to delete "${tag.name}"?`;
    const content: ComponentContent<TagDeleteSheetParams> =
      new ComponentContent(this.getUIContext(), wrapBuilder(tagDeleteSheet), params);
    params.onDelete = (): void => {
      prompt.closeCustomDialog(content);
      this.deleteConfirmed(tag, index, source);
    };
    params.onCancel = (): void => {
      prompt.closeCustomDialog(content);
      hilog.info(DOMAIN, LOG_TAG, 'tag deletion cancelled');
    };
    prompt.openCustomDialog(content, {
      alignment: DialogAlignment.Center,
      autoCancel: true
    });
  }

  private deleteConfirmed(tag: Tag, index: number, source: TagListViewCellDeletionSource): void {
    // verifyTagIsAtIndexPath (issue #1312)
    if (index >= this.tags.length || this.tags[index].simperiumKey !== tag.simperiumKey) {
      const failed: AlertDialogParamWithOptions = {
        title: 'Could not delete tag',
        message: 'Please try again',
        buttons: [{ value: 'Ok', action: (): void => {
          hilog.info(DOMAIN, LOG_TAG, 'delete failure acknowledged');
        } }]
      };
      this.getUIContext().showAlertDialog(failed);
      return;
    }
    if (source === TagListViewCellDeletionSource.ACCESSORY) {
      SPTracker.trackTagRowDeleted();
    } else {
      SPTracker.trackTagMenuDeleted();
    }
    if (this.selectedTag === tag.name) {
      SessionStore.shared().selectedTag = null;
    }
    NoteStore.sharedManager().removeTag(tag).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'remove failed: %{public}s', e.message);
    });
  }

  /// Live reorder feedback (UITableView reorder control): while a handle is dragged, the rows between its start
  /// and the current target slide one row towards the start, so the order shown is the order a drop saves.
  private dragChanged(tag: Tag, rows: number, rowHeight: number, active: boolean): void {
    if (!active) {
      this.dragKey = '';
      this.dragRows = 0;
      return;
    }
    if (this.dragKey === tag.simperiumKey && this.dragRows === rows) {
      return;
    }
    this.dragKey = tag.simperiumKey;
    this.dragRowHeight = rowHeight;
    animateTo({ duration: 150, curve: Curve.EaseOut }, (): void => {
      this.dragRows = rows;
    });
  }

  private dragShiftFor(index: number): number {
    const from: number = this.tags.findIndex((t: Tag): boolean => t.simperiumKey === this.dragKey);
    if (from < 0 || index === from) {
      return 0;
    }
    const to: number = Math.min(Math.max(from + this.dragRows, 0), this.tags.length - 1);
    if (to > from && index > from && index <= to) {
      return -this.dragRowHeight;
    }
    if (to < from && index >= to && index < from) {
      return this.dragRowHeight;
    }
    return 0;
  }

  /// tableView(_:moveRowAt:to:) -> SPObjectManager.moveTag
  private moveTag(from: number, to: number): void {
    // Called from the row's reorder-handle PanGesture (ForEach.onMove never fires inside a ListItemGroup).
    // Reorder the local rows at once, as UIKit's moved row, then the store persists the new order.
    this.tags.splice(to, 0, this.tags.splice(from, 1)[0]);
    NoteStore.sharedManager().moveTagFromIndex(from, to).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'move failed: %{public}s', e.message);
    });
  }

  // MARK: - Keyboard support (List): up / down traverse the rows, return selects, trailing arrow hides.
  // Rows in table order: All Notes, Trash, Settings, the tags, Untagged Notes.

  sidebarVisibleDidChange(): void {
    this.settingsHighlighted = false;
  }

  private traversalIndex(): number {
    if (this.settingsHighlighted) {
      return 2;
    }
    const filter: NotesListFilter = NotesListFilter.fromSelectedTag(this.selectedTag);
    if (filter.kind === NotesListFilterKind.EVERYTHING) {
      return 0;
    }
    if (filter.kind === NotesListFilterKind.DELETED) {
      return 1;
    }
    if (filter.kind === NotesListFilterKind.UNTAGGED) {
      return 3 + this.tags.length;
    }
    const tagIndex: number = this.tags.findIndex((t: Tag): boolean => t.name === filter.name);
    // The selected tag can be gone (deleted on another device): traverse from All Notes.
    return tagIndex < 0 ? 0 : 3 + tagIndex;
  }

  /// didSelectRow(at:isTraversing:) for the row at a traversal index; traversing onto Settings only moves the
  /// highlight (updateSelectionWhileTraversing: "Skip for settings"), selecting it opens Settings.
  private selectRow(index: number, isTraversing: boolean): void {
    this.settingsHighlighted = isTraversing && index === 2;
    if (index === 0) {
      this.didSelectAllNotes(isTraversing);
    } else if (index === 1) {
      this.didSelectTrash(isTraversing);
    } else if (index === 2) {
      if (!isTraversing) {
        this.openSettings();
      }
    } else if (index - 3 < this.tags.length) {
      this.didSelectTag(this.tags[index - 3], isTraversing);
    } else {
      this.didSelectBottomRow(isTraversing);
    }
  }

  /// keyCommands: trailing arrow -> keyboardHideSidebar; up / down -> select prev / next row; return ->
  /// executeSelection.
  private handleKey(keyCode: number): boolean {
    if (this.renameTagKey.length > 0) {
      return false;
    }
    const last: number = 3 + this.tags.length;
    if (keyCode === KeyCode.KEYCODE_DPAD_RIGHT) {
      AppStorage.setOrCreate<boolean>(SIDEBAR_VISIBLE_KEY, false);
      return true;
    }
    if (keyCode === KeyCode.KEYCODE_DPAD_UP) {
      this.selectRow(Math.max(0, this.traversalIndex() - 1), true);
      return true;
    }
    if (keyCode === KeyCode.KEYCODE_DPAD_DOWN) {
      this.selectRow(Math.min(last, this.traversalIndex() + 1), true);
      return true;
    }
    if (keyCode === KeyCode.KEYCODE_ENTER || keyCode === KeyCode.KEYCODE_NUMPAD_ENTER) {
      this.selectRow(this.traversalIndex(), false);
      return true;
    }
    return false;
  }

  @Builder
  tagsHeader() {
    SPTagHeaderView({
      title: 'Tags',
      actionTitle: this.isEditingTags ? 'Done' : 'Edit',
      isEditing: this.isEditingTags,
      actionId: 'tag_list_edit',
      onAction: (): void => {
        this.editTagsTap();
      }
    })
  }

  build() {
    List() {
      // Section.system
      ListItemGroup() {
        ListItem() {
          Value1TableViewCell({
            cellId: 'all-notes',
            title: 'All Notes',
            symbol: $r('sys.symbol.doc_plaintext'),
            hasClearBackground: true,
            onTap: (): void => {
              if (!this.touchMoved) {
                this.didSelectAllNotes(false);
              }
            }
          })
        }
        .backgroundColor(this.isSelected(NotesListFilterKind.EVERYTHING, '') ?
          $r('sys.color.interactive_select') : Color.Transparent)
        .borderRadius($r('sys.float.corner_radius_level8'))
        ListItem() {
          Value1TableViewCell({
            cellId: 'trash',
            title: 'Trash',
            symbol: $r('sys.symbol.trash'),
            hasClearBackground: true,
            onTap: (): void => {
              if (!this.touchMoved) {
                this.didSelectTrash(false);
              }
            }
          })
        }
        .backgroundColor(this.isSelected(NotesListFilterKind.DELETED, '') ?
          $r('sys.color.interactive_select') : Color.Transparent)
        .borderRadius($r('sys.float.corner_radius_level8'))
        ListItem() {
          Value1TableViewCell({
            cellId: 'settings',
            title: 'Settings',
            symbol: $r('sys.symbol.gearshape'),
            hasClearBackground: true,
            onTap: (): void => {
              this.openSettings();
            }
          })
        }
        .backgroundColor(this.settingsHighlighted ? $r('sys.color.interactive_select') : Color.Transparent)
        .borderRadius($r('sys.float.corner_radius_level8'))
      }
      .margin({ bottom: 8 })

      // Section.tags — only when the tag store's results controller has objects (numberOfObjects > 0);
      // with none, only the system + bottom sections render.
      if (this.tags.length > 0 && this.tagStore.tags().length > 0) {
        ListItemGroup({ header: this.tagsHeader() }) {
          ForEach(this.tags, (tag: Tag, index: number) => {
            ListItem() {
              TagListViewCell({
                tagName: tag.name,
                shiftY: this.dragShiftFor(index),
                onDragChange: (rows: number, rowHeight: number, active: boolean): void => {
                  this.dragChanged(tag, rows, rowHeight, active);
                },
                isEditing: this.isEditingTags,
                // canMoveRowAt: tag rows, only while editing and when alphabetical sort is off
                canReorder: this.isEditingTags && !this.alphabetical,
                isRenaming: this.renameTagKey === tag.simperiumKey,
                onDelete: (source: TagListViewCellDeletionSource): void => {
                  this.confirmDeleteTag(tag, source);
                },
                onRename: (): void => {
                  SPTracker.trackTagMenuRenamed();
                  this.renameTag(tag);
                },
                onEndRename: (newName: string): void => {
                  this.endRename(tag, newName);
                },
                onDraftChange: (draft: string): void => {
                  this.renameDraft = draft;
                },
                onReorder: (rows: number): void => {
                  const from: number = this.tags.findIndex((t: Tag): boolean => t.simperiumKey === tag.simperiumKey);
                  const to: number = Math.min(Math.max(from + rows, 0), this.tags.length - 1);
                  if (from >= 0 && to !== from) {
                    this.moveTag(from, to);
                  }
                }
              })
            }
            .id('tag_list_itemroot')
            // The dragged row paints above the rows it passes
            .zIndex(tag.simperiumKey === this.dragKey ? 1 : 0)
            .backgroundColor(this.isSelected(NotesListFilterKind.TAG, tag.name) ?
              $r('sys.color.interactive_select') : Color.Transparent)
            .borderRadius($r('sys.float.corner_radius_level8'))
            .onClick((): void => {
              if (!this.touchMoved) {
                this.didSelectTag(tag, false);
              }
            })
          }, (tag: Tag): string => `${tag.simperiumKey}|${tag.name}`)
        }
        .margin({ bottom: 8 })
      }

      // Section.bottom
      ListItemGroup() {
        ListItem() {
          Value1TableViewCell({
            cellId: 'untagged-notes',
            title: 'Untagged Notes',
            symbol: $r('sys.symbol.bookmark'),
            hasClearBackground: true,
            onTap: (): void => {
              if (!this.touchMoved) {
                this.didSelectBottomRow(false);
              }
            }
          })
        }
        .backgroundColor(this.isSelected(NotesListFilterKind.UNTAGGED, '') ?
          $r('sys.color.interactive_select') : Color.Transparent)
        .borderRadius($r('sys.float.corner_radius_level8'))
      }
    }
    .width('100%')
    .height('100%')
    // HarmonyOS side bar: rows inset 8vp so the selection reads as a rounded highlight
    .padding({ start: LengthMetrics.vp(8), end: LengthMetrics.vp(8), top: LengthMetrics.vp(8) })
    .scrollBar(BarState.Off)
    .backgroundColor($r('sys.color.background_primary'))
    .onTouch((event: TouchEvent): void => {
      this.trackTouch(event);
    })
    // Standalone page only: inside the note list's sidebar the list page forwards keys through `keys`.
    .onKeyEvent((event: KeyEvent): void => {
      if (this.keys === null && event.type === KeyType.Down && this.handleKey(event.keyCode)) {
        event.stopPropagation();
      }
    })
  }
}

@Entry
@Component
struct TagListViewControllerPage {
  build() {
    Column() {
      TagListViewController({
        showNoteList: (): void => {
          // Opened over the note list (deep link): pop back to it; opened alone: replace with it.
          if (router.getLength() !== '1') {
            router.back();
          } else {
            router.replaceUrl({ url: 'pages/SPNoteListViewControllerPage' }).catch((e: Error) => {
              hilog.error(DOMAIN, LOG_TAG, 'note list failed: %{public}s', e.message);
            });
          }
        }
      })
    }
    .id('screen_tag_list')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background'))
  }
}
