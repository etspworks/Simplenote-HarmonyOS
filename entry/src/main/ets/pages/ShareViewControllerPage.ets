// Port of SimplenoteShare/ViewControllers/ShareViewController.swift + Simperium/Uploader.swift + Simperium/Note.swift.
// Loaded by ShareExtAbility via session.loadContent; 'session' and 'text' come in through the shared LocalStorage.
import { UIExtensionContentSession } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { KeychainManager } from '../common/PinLockManager';
import { SPCredentials } from '../common/simperium/Simperium';
import { SP_BASE_URL } from '../common/simperium/WebSocketChannel';
import { HttpRemoteSession, RemoteRequest, REMOTE_METHOD_POST } from '../common/endpoints/Remote';

@Entry({ useSharedStorage: true })
@Component
struct ShareViewControllerPage {
  @LocalStorageLink('text') text: string = '';
  /// originalNote?.markdown: the shared file was Markdown (.md / .markdown / .textbundle / .textpack)
  @LocalStorageProp('markdown') isMarkdown: boolean = false;
  private token: string | null = null;
  private saving: boolean = false;

  aboutToAppear(): void {
    this.token = KeychainManager.extensionToken;
  }

  onPageShow(): void {
    // ensureSimperiumTokenIsValid -> displayMissingAccountAlert
    if (this.token === null) {
      this.getUIContext().showAlertDialog({
        title: $r('app.string.no_simplenote_account'),
        message: $r('app.string.please_log_into_your_simplenote_account_first_by_using_the_s'),
        autoCancel: false,
        confirm: { value: $r('app.string.cancel_share'), action: () => this.dismissExtension() },
        cancel: () => this.dismissExtension()
      });
    }
  }

  onBackPress(): boolean {
    this.dismissExtension(); // swipe-down dismissal on iOS == cancel
    return true;
  }

  private dismissExtension(): void {
    const session = this.getUIContext().getSharedLocalStorage()?.get<UIExtensionContentSession>('session');
    session?.terminateSelf();
  }

  private cancelWasPressed(): void {
    this.dismissExtension();
  }

  private async saveWasPressed(): Promise<void> {
    if (this.saving) {
      return;
    }
    this.saving = true;
    // Don't bother saving empty notes.
    if (this.text !== '' && this.token !== null) {
      try {
        // iOS uses a background URLSession that outlives the extension; HarmonyOS has none, so await before dismissing.
        await HttpRemoteSession.shared.data(ShareViewControllerPage.requestToSend(this.text, this.isMarkdown, this.token));
      } catch (e) {
        // Uploader.send errors are dropped on iOS as well.
      }
    }
    this.dismissExtension();
  }

  /// Uploader.requestToSend + Note.toDictionary (markdown is only set for .md/.textbundle file shares).
  private static requestToSend(content: string, markdown: boolean, token: string): RemoteRequest {
    const key: string = util.generateRandomUUID(false).replace(/-/g, '');
    const request = new RemoteRequest((SP_BASE_URL + SPCredentials.SIMPERIUM_APP_ID + '/note/i/' + key).toLowerCase());
    request.httpMethod = REMOTE_METHOD_POST;
    const now: number = Date.now() / 1000;
    request.httpBody = JSON.stringify({
      'tags': [] as string[],
      'deleted': 0,
      'shareURL': '',
      'publishURL': '',
      'content': content,
      'systemTags': (markdown ? ['markdown'] : []) as string[],
      'creationDate': now,
      'modificationDate': now
    } as Record<string, Object>);
    request.setValue(token, 'X-Simperium-Token');
    return request;
  }

  build() {
    Column() {
      // HarmonyOS edit title bar: close (X) = Cancel, checkmark = Save. EditableTitleBar does not expose its
      // buttons, so the share_cancel / share_save ids sit on two wrappers around it.
      Column() {
        Column() {
          EditableTitleBar({
            leftIconStyle: EditableLeftIconType.Cancel,
            title: $r('app.string.simplenote'),
            isSaveIconRequired: true,
            onSave: (): void => {
              this.saveWasPressed();
            },
            onCancel: (): void => {
              this.cancelWasPressed();
            }
          })
        }
        .id('share_save')
        .width('100%')
      }
      .id('share_cancel')
      .width('100%')

      // UITextView: editable, no placeholder, first responder on appear (textViewInsets 8/12).
      TextArea({ text: $$this.text })
        .id('share_text')
        .defaultFocus(true)
        .layoutWeight(1)
        .width('100%')
        .borderRadius(0)
        .padding({ top: 8, bottom: 8, left: 12, right: 12 })
        .fontSize($r('sys.float.Body_L'))
        .fontColor($r('sys.color.font_primary'))
        .caretColor($r('sys.color.brand'))
        .backgroundColor($r('sys.color.background_primary'))
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.background_primary'))
  }
}
