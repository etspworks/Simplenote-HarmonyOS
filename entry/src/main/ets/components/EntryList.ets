import { LengthMetrics } from '@kit.ArkUI';
// Port of SPEntryListViewController (+ SPEntryListCell / SPEntryListAutoCompleteCell): the entry
// field (HarmonyOS text field, email keyboard) with its plus button, a card of PersonTag rows
// (name + email, swipe-to-delete with a round trash action) and the autocomplete card
// table that replaces it while matches exist. The subclass (SPAddCollaboratorsViewController page)
// owns the data and the header/footer titles; this component renders them and reports events.
import { ArrayDataSource } from '../common/ArrayDataSource';
import { PersonTag } from '../model/PersonTag';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HmIconButton } from './HmIconButton';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'EntryList';

@Component
export struct SPEntryListViewController {
  @Link entryText: string;
  @Prop placeholder: string = '';
  @Prop headerTitle: string = '';
  @Prop footerTitle: string = '';
  @Prop showEntryFieldPlusButton: boolean = true;
  @Prop showAutoComplete: boolean = false;
  /// HarmonyOS only: the suggestions are the contacts picked in the system picker, so typed text that
  /// matches none of them offers the picker again (iOS searches the whole address book instead).
  @Prop showChooseContacts: boolean = false;
  dataSource: ArrayDataSource<PersonTag> = new ArrayDataSource<PersonTag>([]);
  autoCompleteDataSource: ArrayDataSource<PersonTag> = new ArrayDataSource<PersonTag>([]);
  /// textFieldShouldReturn: -> processTextInField
  onEntrySubmit: () => void = () => {
    hilog.warn(DOMAIN, LOG_TAG, 'onEntrySubmit not handled by the host');
  };
  /// textField:shouldChangeCharactersInRange: -> updateAutoCompleteMatchesForString:
  onEntryChange: (text: string) => void = (text: string) => {
    hilog.warn(DOMAIN, LOG_TAG, 'onEntryChange not handled by the host');
  };
  /// entryFieldPlusButtonTapped:
  onPlusTapped: () => void = () => {
    hilog.warn(DOMAIN, LOG_TAG, 'onPlusTapped not handled by the host');
  };
  /// tableView:didSelectRowAtIndexPath: (primary table)
  onRowTapped: (index: number) => void = (index: number) => {
    hilog.warn(DOMAIN, LOG_TAG, 'onRowTapped not handled by the host');
  };
  /// tableView:commitEditingStyle:forRowAtIndexPath: -> removeItemFromDataSourceAtIndexPath:
  onRowDeleted: (index: number) => void = (index: number) => {
    hilog.warn(DOMAIN, LOG_TAG, 'onRowDeleted not handled by the host');
  };
  onChooseContacts: () => void = () => {
    hilog.warn(DOMAIN, LOG_TAG, 'onChooseContacts not handled by the host');
  };
  /// tableView:didSelectRowAtIndexPath: (autocomplete table)
  onAutoCompleteTapped: (index: number) => void = (index: number) => {
    hilog.warn(DOMAIN, LOG_TAG, 'onAutoCompleteTapped not handled by the host');
  };

  /// HarmonyOS swipe action: a 40vp round trash symbol on warning.
  @Builder
  deleteAction(index: number) {
    Row() {
      Button({ type: ButtonType.Circle, stateEffect: true }) {
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(24)
          .fontColor([$r('sys.color.icon_on_primary')])
      }
      .width(40)
      .height(40)
      .backgroundColor($r('sys.color.warning'))
      .accessibilityText('Delete')
      .onClick(() => this.onRowDeleted(index))
    }
    .height('100%')
    .padding({ start: LengthMetrics.vp(8), end: LengthMetrics.vp(16) })
  }

  /// Sentence-case card-group sub-header (as Settings), not the iOS uppercase grouped header.
  @Builder
  sectionHeader() {
    if (this.headerTitle.length > 0) {
      Text(this.headerTitle)
        .fontSize($r('sys.float.Subtitle_S'))
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(12), bottom: LengthMetrics.vp(8) })
    }
  }

  @Builder
  sectionFooter() {
    if (this.footerTitle.length > 0) {
      Text(this.footerTitle)
        .fontSize($r('sys.float.Body_S'))
        .fontColor($r('sys.color.font_secondary'))
        .width('100%')
        .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(8) })
    }
  }

  /// Two-line person row text: name (or email) over the email in Body_M secondary.
  @Builder
  personLabels(person: PersonTag, nameWeight: FontWeight) {
    Text(person.name.length > 0 ? person.name : person.email)
      .fontSize($r('sys.float.Body_L'))
      .fontWeight(nameWeight)
      .fontColor($r('sys.color.font_primary'))
      .maxLines(1)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
    if (person.name.length > 0) {
      Text(person.email)
        .fontSize($r('sys.float.Body_M'))
        .fontColor($r('sys.color.font_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
  }

  /// A rounded HarmonyOS list card on the grouped page background.
  @Styles
  card() {
    .backgroundColor($r('sys.color.comp_background_list_card'))
    .borderRadius($r('sys.float.corner_radius_level8'))
    .clip(true)
  }

  @Styles
  pressedRow() {
    .stateStyles({
      normal: {
        .backgroundColor(Color.Transparent)
      },
      pressed: {
        .backgroundColor($r('sys.color.interactive_pressed'))
      }
    })
  }

  build() {
    Column() {
      // entryFieldBackground: HarmonyOS text field + plus button (rightView)
      Row({ space: 8 }) {
        TextInput({ placeholder: this.placeholder, text: this.entryText })
          .id('collaborators_entry_field')
          .type(InputType.Email)
          .enterKeyType(EnterKeyType.Done)
          .layoutWeight(1)
          .height(40)
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.font_primary'))
          .placeholderColor($r('sys.color.font_tertiary'))
          .caretColor($r('sys.color.brand'))
          .backgroundColor($r('sys.color.comp_background_tertiary'))
          .borderRadius($r('sys.float.corner_radius_level10'))
          .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
          .onChange((value: string) => this.onEntryChange(value))
          .onSubmit(() => this.onEntrySubmit())
        if (this.showEntryFieldPlusButton) {
          HmIconButton({
            symbol: $r('sys.symbol.person_badge_plus'),
            label: 'Add from contacts',
            buttonId: 'collaborators_add',
            action: () => this.onPlusTapped()
          })
        }
      }
      .width('100%')
      .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(8) })

      if (this.showChooseContacts && !this.showAutoComplete) {
        Text('Choose Contacts for Suggestions')
          .id('collaborators_choose_contacts')
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('sys.color.font_emphasize'))
          .width('100%')
          .constraintSize({ minHeight: 48 })
          .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
          .onClick(() => this.onChooseContacts())
      }
      if (this.showAutoComplete) {
        // autoCompleteTableView: one card of 56vp two-line rows
        List() {
          LazyForEach(this.autoCompleteDataSource, (person: PersonTag, index: number) => {
            ListItem() {
              Column({ space: 2 }) {
                this.personLabels(person, FontWeight.Regular)
              }
              .width('100%')
              .constraintSize({ minHeight: 56 })
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Start)
              .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(8) })
              .pressedRow()
            }
            .id('collaborators_autocomplete_itemroot')
            .onClick(() => this.onAutoCompleteTapped(index))
          }, (person: PersonTag) => person.email)
        }
        .width('100%')
        .flexShrink(1)
        .card()
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 16, endMargin: 16 })
        .margin({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(4) })
      } else {
        // primaryTableView: sentence-case header, one card of collaborators, footer text
        this.sectionHeader()
        List() {
          LazyForEach(this.dataSource, (person: PersonTag, index: number) => {
            ListItem() {
              Column({ space: 2 }) {
                this.personLabels(person, FontWeight.Medium)
              }
              .width('100%')
              .constraintSize({ minHeight: 48 })
              .justifyContent(FlexAlign.Center)
              .alignItems(HorizontalAlign.Start)
              .padding({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16), top: LengthMetrics.vp(8), bottom: LengthMetrics.vp(8) })
              .backgroundColor($r('sys.color.comp_background_list_card'))
            }
            .id('collaborators_itemroot')
            .swipeAction({ end: { builder: () => { this.deleteAction(index) } } })
            .onClick(() => this.onRowTapped(index))
          }, (person: PersonTag) => person.email + ':' + String(person.active))
        }
        .width('100%')
        .flexShrink(1)
        .card()
        .divider({ strokeWidth: '1px', color: $r('sys.color.comp_divider'), startMargin: 16, endMargin: 16 })
        .margin({ start: LengthMetrics.vp(16), end: LengthMetrics.vp(16) })
        this.sectionFooter()
      }
    }
    .width('100%')
    .layoutWeight(1)
    .backgroundColor($r('sys.color.background_secondary'))
  }
}
