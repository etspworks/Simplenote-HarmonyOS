// Port of Simplenote/Classes/SPMarkdownParser.m: Markdown -> full HTML page for the preview Web
// component. The Markdown itself is rendered by the Hoextdown port; this module wraps it in the
// header (viewport, font, CSS) and footer the source adds.
// The CSS files ship in resources/rawfile/ (the NSBundle resources of the source).
import { application } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { resourceManager } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  hoedown_render_markdown_to_html,
  SP_MARKDOWN_EXTENSIONS,
  SP_MARKDOWN_HTML_FLAGS,
  SP_MARKDOWN_MAX_NESTING
} from './hoextdown/HtmlRenderer';

const DOMAIN: number = 0x0001;
const LOG_TAG: string = 'SPMarkdownParser';

const HTML_HEADER_START: string = '<html><head>' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<link href="https://fonts.googleapis.com/css?family=Noto+Serif" rel="stylesheet">' +
  '<style media="screen" type="text/css">\n';
const HTML_HEADER_END: string = '</style></head><body><div class="note-detail-markdown">';
const HTML_FOOTER: string = '</div></body></html>';

export class SPMarkdownParser {
  /// UIAccessibilityContrastHigh: HarmonyOS exposes no public "increase contrast" query, so the
  /// UI layer sets this when it knows (defaults to off).
  static highContrastEnabled: boolean = false;

  static renderHTMLFromMarkdownString(markdown: string): string {
    const htmlString: string = hoedown_render_markdown_to_html(markdown ?? '', SP_MARKDOWN_HTML_FLAGS,
      SP_MARKDOWN_EXTENSIONS, SP_MARKDOWN_MAX_NESTING);
    return SPMarkdownParser.htmlHeader() + htmlString + SPMarkdownParser.htmlFooter();
  }

  static htmlHeader(): string {
    const css: string = SPMarkdownParser.cssForMarkdown();
    return HTML_HEADER_START + css + HTML_HEADER_END;
  }

  static cssForMarkdown(): string {
    let css: string = SPMarkdownParser.loadCSSAtPath(SPMarkdownParser.cssPath());

    // Load CSS colors
    const colors: string = SPMarkdownParser.loadCSSAtPath(SPMarkdownParser.cssColorPath());
    css = css + colors;

    // If increase contrast is enabled, amend CSS to include high contrast colors
    if (SPMarkdownParser.highContrastEnabled) {
      const contrast: string = SPMarkdownParser.loadCSSAtPath(SPMarkdownParser.contrastCssPath());
      css = css + contrast;
    }
    return css;
  }

  static loadCSSAtPath(path: string): string {
    try {
      const bytes: Uint8Array = application.getApplicationContext().resourceManager.getRawFileContentSync(path);
      const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
      return decoder.decodeToString(bytes);
    } catch (e) {
      // stringWithContentsOfURL returns nil on a missing resource; the header then carries no CSS
      hilog.error(DOMAIN, LOG_TAG, 'cannot load %{public}s: %{public}s', path, JSON.stringify(e));
      return '';
    }
  }

  static cssPath(): string {
    return 'markdown-default.css';
  }

  static cssColorPath(): string {
    if (SPMarkdownParser.isDark()) {
      return 'markdown-dark.css';
    }
    return 'markdown-light.css';
  }

  static contrastCssPath(): string {
    if (SPMarkdownParser.isDark()) {
      return 'markdown-dark-contrast.css';
    }
    return 'markdown-default-contrast.css';
  }

  static htmlFooter(): string {
    return HTML_FOOTER;
  }

  /// SPUserInterface.isDark: the current trait collection's style
  private static isDark(): boolean {
    const config: resourceManager.Configuration =
      application.getApplicationContext().resourceManager.getConfigurationSync();
    return config.colorMode === resourceManager.ColorMode.DARK;
  }
}

export { SPMarkdownParser as MarkdownRenderer };
