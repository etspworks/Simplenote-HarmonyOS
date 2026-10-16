// Port of TagListViewCell.swift (+ .xib): a text field holding the tag name (enabled only while renaming),
// and a trash button container visible only in edit mode. Long-press shows the Delete / Rename callout
// (UIMenuController, TagListViewCell.canPerformAction). The row root id (tag_list_itemroot) and the tap
// are attached by the list, which owns selection.
import { LengthMetrics } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { tagHash } from '../common/NoteStore';
import { TagInputValidation, validateTagInput } from '../model/TagTextFieldInputValidator';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'TagListViewCell';
const TAG_RENAME_FIELD_ID: string = 'tag_rename_field';

/// TagListViewCellDeletionSource
export enum TagListViewCellDeletionSource {
  MENU = 0,
  ACCESSORY = 1
}

@Component
export struct TagListViewCell {
  @Prop tagName: string = '';
  /// setEditing(_:animated:) -> trashButtonContainer.isHidden = !editing
  @Prop isEditing: boolean = false;
  /// UITableView editing + canMoveRowAt -> the system reorder control (three grey lines) at the trailing edge
  @Prop canReorder: boolean = false;
  /// textField.isEnabled (renameTag -> becomeFirstResponder)
  @Prop @Watch('renamingDidChange') isRenaming: boolean = false;
  @State draft: string = '';
  /// The field text as last accepted by the validator (a rejected edit reverts to it)
  private acceptedText: string = '';
  private renameController: TextInputController = new TextInputController();
  /// Caret to put back once a rejected edit's revert reaches the field (-1: none)
  private revertedCaret: number = -1;
  /// UIMenuController visible (the long-press callout); the row stays highlighted meanwhile, as on iOS
  @State showMenu: boolean = false;
  /// The row follows the finger while the reorder handle is dragged (vp)
  @State dragOffsetY: number = 0;
  /// Lifted while its reorder handle is dragged (UITableView reorder: opaque, shadowed, above its neighbours)
  @State dragging: boolean = false;
  /// Live gap: a neighbour of the dragged row slides by one row while the drag passes it (vp)
  @Prop shiftY: number = 0;
  private rowHeight: number = 44;
  /// tableView(_:moveRowAt:to:): the handle was released `rows` rows below (+) / above (-) its start
  onReorder: (rows: number) => void = (rows: number): void => {
    hilog.warn(DOMAIN, LOG_TAG, 'reorder (%{public}d) with no delegate', rows);
  };
  /// The dragged row's target, in rows from its start, while the handle is held; `active` false on release
  onDragChange: (rows: number, rowHeight: number, active: boolean) => void =
    (_rows: number, _rowHeight: number, _active: boolean): void => {
    };
  /// TagListViewCellDelegate.tagListViewCellShouldDeleteTag
  onDelete: (source: TagListViewCellDeletionSource) => void = (source: TagListViewCellDeletionSource): void => {
    hilog.warn(DOMAIN, LOG_TAG, 'delete (%{public}d) with no delegate', source);
  };
  /// TagListViewCellDelegate.tagListViewCellShouldRenameTag
  onRename: () => void = (): void => {
    hilog.warn(DOMAIN, LOG_TAG, 'rename with no delegate');
  };
  /// textFieldDidEndEditing -> the controller's rename
  onEndRename: (newName: string) => void = (newName: string): void => {
    hilog.warn(DOMAIN, LOG_TAG, 'end rename (%{public}d chars) with no delegate', newName.length);
  };

  /// The field's text as typed, so the controller can commit a rename still open when editing ends
  onDraftChange: (draft: string) => void = (_draft: string): void => {
  };

  aboutToAppear(): void {
    this.draft = this.tagName;
    this.acceptedText = this.tagName;
  }

  renamingDidChange(): void {
    this.draft = this.tagName;
    this.acceptedText = this.tagName;
  }

  /// textField.becomeFirstResponder(). Deferred with one retry, as EditorTextView.becomeFirstResponder:
  /// defaultFocus only applies to a page's first focus, not to a field created later.
  private becomeFirstResponder(): void {
    setTimeout((): void => {
      if (!focusControl.requestFocus(TAG_RENAME_FIELD_ID)) {
        setTimeout((): void => {
          focusControl.requestFocus(TAG_RENAME_FIELD_ID);
        }, 100);
      }
    }, 0);
  }

  /// textField(_:shouldChangeCharactersIn:replacementString:) + TagTextFieldInputValidator: a whitespace /
  /// comma typed at the end ends editing with the trimmed name; embedded ones, or a name whose tag-hash
  /// encoding exceeds 256, reject the keystroke (the text stays as it was, no alert, as on iOS).
  private validateInput(value: string): void {
    if (value === this.acceptedText) {
      // the reverted text has been applied (which put the caret at the end): restore the caret now
      if (this.revertedCaret >= 0) {
        const caret: number = this.revertedCaret;
        this.revertedCaret = -1;
        setTimeout((): void => {
          this.renameController.caretPosition(caret);
        }, 0);
      }
      return;
    }
    const validation: TagInputValidation =
      validateTagInput(this.acceptedText, value, (tag: string): number => tagHash(tag).length);
    if (validation.result === 'invalid') {
      // shouldChangeCharactersIn -> false: the text and the caret stay where they were (resetting the text
      // alone moves the caret to the end, where the next ',' or space would end editing)
      this.revertedCaret = Math.max(0,
        this.renameController.getCaretOffset().index - (value.length - this.acceptedText.length));
      this.draft = this.acceptedText;
      return;
    }
    this.acceptedText = validation.tag;
    this.draft = validation.tag;
    this.onDraftChange(validation.tag);
    if (validation.result === 'endingWithDisallowedCharacter') {
      this.onEndRename(validation.tag);
    }
  }

  /// The long-press Delete / Rename callout, drawn as a HarmonyOS menu: 48vp rows with a leading symbol,
  /// Delete in warning, an inset divider between them.
  @Builder
  tagMenu() {
    Column() {
      Row({ space: 12 }) {
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(24)
          .fontColor([$r('sys.color.warning')])
          .accessibilityLevel('no')
        Text('Delete')
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.warning'))
      }
      .width('100%')
      .height(48)
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
      .onClick((): void => {
        this.showMenu = false;
        this.onDelete(TagListViewCellDeletionSource.MENU);
      })
      Divider()
        .color($r('sys.color.comp_divider'))
        .margin({ start: LengthMetrics.vp(52), end: LengthMetrics.vp(16) })
      Row({ space: 12 }) {
        SymbolGlyph($r('sys.symbol.square_and_pencil'))
          .fontSize(24)
          .fontColor([$r('sys.color.icon_primary')])
          .accessibilityLevel('no')
        Text('Rename')
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.font_primary'))
      }
      .width('100%')
      .height(48)
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
      .onClick((): void => {
        this.showMenu = false;
        this.onRename();
      })
    }
    .width(160)
    .padding({ top: LengthMetrics.vp(4), bottom: LengthMetrics.vp(4) })
  }

  build() {
    // stackView spacing 10
    Row({ space: 10 }) {
      if (this.isRenaming) {
        TextInput({ text: $$this.draft, controller: this.renameController })
          .id(TAG_RENAME_FIELD_ID)
          .onAppear((): void => {
            this.becomeFirstResponder();
          })
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.font_primary'))
          .caretColor($r('sys.color.brand'))
          .backgroundColor(Color.Transparent)
          .borderRadius(0)
          .padding(0)
          .layoutWeight(1)
          .onChange((value: string): void => {
            this.validateInput(value);
          })
          .onSubmit((): void => {
            this.onEndRename(this.draft);
          })
          .onBlur((): void => {
            this.onEndRename(this.draft);
          })
      } else {
        // textField: body, simplenoteTextColor
        Text(this.tagName)
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.font_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          // Long press shows Delete / Rename, in edit mode too (as on iOS). Bound to the name only, so a long
          // press on the reorder handle reaches the List drag-sort instead of the menu.
          .gesture(LongPressGesture().onAction((): void => {
            this.showMenu = true;
          }))
          .bindPopup(this.showMenu, {
            builder: this.tagMenu,
            placement: Placement.Top,
            enableArrow: false,
            radius: $r('sys.float.corner_radius_level8'),
            popupColor: $r('sys.color.comp_background_primary'),
            onStateChange: (e): void => {
              if (!e.isVisible) {
                this.showMenu = false;
              }
            }
          })
      }
      if (this.isEditing) {
        // trashButton (icon_trash) -> handleTapOnTrashButton. The source button carries no identifier.
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(24)
          .fontColor([$r('sys.color.warning')])
          // trashButtonContainer: 4pt trailing space after the button
          .margin({ end: LengthMetrics.vp(4) })
          // Image is draggable by default; its own drag would swallow the long press meant for the list.
          .draggable(false)
          .accessibilityText('Delete tag')
          .onClick((): void => {
            this.onDelete(TagListViewCellDeletionSource.ACCESSORY);
          })
      }
      if (this.canReorder) {
        // UITableViewCellReorderControl stand-in. Like the iOS control it drags at once (no long press):
        // ForEach.onMove never fires here, the tag rows live in a ListItemGroup.
        SymbolGlyph($r('sys.symbol.line_3_horizontal'))
          .fontSize(24)
          .fontColor([$r('sys.color.icon_tertiary')])
          .draggable(false)
          .accessibilityText('Reorder')
          .gesture(PanGesture({ direction: PanDirection.Vertical })
            .onActionStart((): void => {
              this.dragging = true;
            })
            .onActionUpdate((event: GestureEvent): void => {
              this.dragOffsetY = event.offsetY;
              this.onDragChange(Math.round(event.offsetY / this.rowHeight), this.rowHeight, true);
            })
            .onActionEnd((event: GestureEvent): void => {
              this.dragging = false;
              this.dragOffsetY = 0;
              this.onDragChange(0, this.rowHeight, false);
              const rows: number = Math.round(event.offsetY / this.rowHeight);
              if (rows !== 0) {
                this.onReorder(rows);
              }
            })
            .onActionCancel((): void => {
              this.dragging = false;
              this.dragOffsetY = 0;
              this.onDragChange(0, this.rowHeight, false);
            }))
      }
    }
    .backgroundColor(this.showMenu ? $r('sys.color.interactive_select') :
      (this.dragging ? $r('sys.color.background_primary') : Color.Transparent))
    .borderRadius($r('sys.float.corner_radius_level8'))
    .shadow(this.dragging ? ShadowStyle.OUTER_DEFAULT_MD : { radius: 0, color: Color.Transparent })
    .translate({ y: this.dragging ? this.dragOffsetY : this.shiftY })
    .onAreaChange((_old: Area, area: Area): void => {
      this.rowHeight = Math.max(1, area.height as number);
    })
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
    .accessibilityText(this.tagName)
  }
}
