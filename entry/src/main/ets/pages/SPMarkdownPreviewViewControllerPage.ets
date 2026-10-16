// Port of SPMarkdownPreviewViewController (.m + +Extensions.swift): pushed from the editor, titled
// 'Preview'. Body: a web view (JavaScript disabled) showing SPMarkdownParser's HTML for the note,
// under a HarmonyOS title bar. Link taps: simplenote:// -> the app's URL router, anything else
// leaves the preview (system browser / owning app).
import { router, EditableTitleBar, EditableLeftIconType } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { KeyCode } from '@kit.InputKit';
import { MarkdownRouteParams } from './SPNoteEditorViewControllerPage';
import { SPMarkdownParser } from '../common/MarkdownRenderer';
import { NoteStore } from '../common/NoteStore';
import { ParsedUrl, ShortcutsHandler } from '../common/DeepLinkRouter';
import { Note } from '../model/Note';
import { InAppBrowserSheet } from '../components/InAppBrowserSheet';

const DOMAIN: number = 0x0002;
const LOG_TAG: string = 'MarkdownPreview';
/// [[NSBundle mainBundle] bundleURL] stand-in: anchors inside the document resolve against it.
const BASE_URL: string = 'resource://rawfile/';

@Entry
@Component
struct SPMarkdownPreviewViewControllerPage {
  /// router param simperiumKey
  private noteKey: string = '';
  /// svc_markdown.render(Note.content)
  @State html: string = '';
  /// SFSafariViewController: a tapped http(s) link in InAppBrowserSheet
  @State showInAppBrowser: boolean = false;
  @State inAppBrowserURL: string = '';
  private webController: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    const params: MarkdownRouteParams | undefined = router.getParams() as MarkdownRouteParams | undefined;
    if (params !== undefined && params !== null) {
      this.noteKey = params.noteKey ?? '';
    }
    this.displayMarkdown();
  }

  /// displayMarkdown
  private displayMarkdown(): void {
    const store: NoteStore = NoteStore.sharedManager();
    store.flushPendingContent();
    const note: Note | undefined = store.notes().find((n: Note): boolean => n.simperiumKey === this.noteKey);
    const markdownText: string = note === undefined ? '' : (note.content ?? '');
    this.html = SPMarkdownParser.renderHTMLFromMarkdownString(markdownText);
  }

  private loadHTML(): void {
    try {
      this.webController.loadData(this.html, 'text/html', 'UTF-8', BASE_URL);
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'loadData failed');
    }
  }

  private isDismissingByKey: boolean = false;

  /// keyCommands: Cmd+Shift+P (Ctrl on HarmonyOS) -> keyboardToggleMarkdownPreview. True = handled.
  private handleKeyCommand(event: KeyEvent): boolean {
    if (event.type !== KeyType.Down || event.keyCode !== KeyCode.KEYCODE_P || this.showInAppBrowser ||
      !event.getModifierKeyState?.(['Ctrl', 'Shift'])) {
      return false;
    }
    if (this.isDismissingByKey) {
      return true; // the web view and the page can both see one key press
    }
    this.isDismissingByKey = true;
    // Popped after this key event is dispatched: popping inside it hands the same Ctrl+Shift+P to the editor's
    // shortcut, which pushed the preview again (device check).
    setTimeout((): void => {
      this.dismissPreview();
    }, 0);
    return true;
  }

  /// back / keyboardToggleMarkdownPreview -> popViewController
  dismissPreview(): void {
    router.back();
  }

  /// webView:decidePolicyForNavigationAction:decisionHandler: — returns true to cancel the load.
  private decidePolicy(request: WebResourceRequest): boolean {
    const targetURL: string = request.getRequestUrl();
    const isAnchorURL: boolean = targetURL.startsWith(BASE_URL) || targetURL.startsWith('data:') ||
      targetURL.startsWith('about:');
    if (!request.isRequestGesture() || isAnchorURL) {
      return false;
    }
    if (ParsedUrl.parse(targetURL).isSimplenoteURL) {
      ShortcutsHandler.shared.handleOpenURL(targetURL);
      return true;
    }
    // [WKWebView handlesURLScheme:] -> SFSafariViewController; other schemes go to the system.
    const scheme: string = targetURL.toLowerCase();
    if (scheme.startsWith('http:') || scheme.startsWith('https:')) {
      this.inAppBrowserURL = targetURL;
      this.showInAppBrowser = true;
      return true;
    }
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.openLink(targetURL).catch((e: Error) => {
      hilog.error(DOMAIN, LOG_TAG, 'openLink failed: %{public}s', e.message);
    });
    return true;
  }

  @Builder
  inAppBrowserSheet() {
    InAppBrowserSheet({
      src: this.inAppBrowserURL,
      onDismiss: (): void => {
        this.showInAppBrowser = false;
      }
    })
  }

  build() {
    Column() {
      // HarmonyOS level-2 title bar. The wrapper carries the back id for QA: EditableTitleBar does not expose
      // its back button.
      Column() {
        EditableTitleBar({
          leftIconStyle: EditableLeftIconType.Back,
          title: $r('app.string.preview'),
          isSaveIconRequired: false,
          onCancel: (): void => {
            this.dismissPreview();
          }
        })
      }
      .id('markdown_preview_back')
      .width('100%')

      Web({ src: '', controller: this.webController })
        .javaScriptAccess(false)
        .backgroundColor($r('app.color.simplenote_background_preview'))
        .width('100%')
        .layoutWeight(1)
        .onControllerAttached((): void => {
          this.loadHTML();
        })
        .onPageEnd((): void => {
          hilog.info(DOMAIN, LOG_TAG, 'MarkdownPreview: rendered %{public}d bytes', this.html.length);
        })
        // Focused on show so key events reach the page at all, and the web view takes them while it has focus.
        .defaultFocus(true)
        .onInterceptKeyEvent((event: KeyEvent): boolean => this.handleKeyCommand(event))
        .onLoadIntercept((event: OnLoadInterceptEvent): boolean => this.decidePolicy(event.data))
    }
    .id('screen_markdown_preview')
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.simplenote_background_preview'))
    .onKeyEvent((event: KeyEvent): boolean => this.handleKeyCommand(event))
    .bindSheet($$this.showInAppBrowser, this.inAppBrowserSheet(), {
      showClose: false,
      height: SheetSize.LARGE,
      dragBar: false,
      backgroundColor: $r('sys.color.background_primary')
    })
  }
}
