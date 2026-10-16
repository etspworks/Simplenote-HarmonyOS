// Port of SimplenoteShare (com.apple.share-services extension): ShareViewController.loadContent +
// Extractors/PlainTextExtractor.extractNote / URLExtractor (loadNote for shared files, buildExternalLinkNote).
// NSExtensionContext -> ShareExtensionAbility session (sheet over the host app) + systemShare.getSharedData.
import { ShareExtensionAbility, UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { zlib } from '@kit.BasicServicesKit';

/// Note(content:markdown:)
class SharedNote {
  content: string;
  markdown: boolean;

  constructor(content: string, markdown: boolean = false) {
    this.content = content;
    this.markdown = markdown;
  }
}

export default class ShareExtAbility extends ShareExtensionAbility {
  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    systemShare.getSharedData(want)
      .then((data: systemShare.SharedData) => this.extractNote(data.getRecords()[0]))
      .catch(() => new SharedNote('')) // iOS shows an empty text view when extraction fails
      .then((note: SharedNote) => {
        const params: Record<string, Object> = { 'session': session, 'text': note.content, 'markdown': note.markdown };
        session.loadContent('pages/ShareViewControllerPage', new LocalStorage(params));
      });
  }

  private async extractNote(record: systemShare.SharedRecord | undefined): Promise<SharedNote> {
    if (record === undefined) {
      return new SharedNote('');
    }
    if (record.content === undefined && record.uri !== undefined) {
      // URLExtractor: a file URL is loaded by its extension; buildExternalLinkNote refuses file URLs
      return (await this.loadNote(record.uri)) ?? new SharedNote('');
    }
    const content: string = record.content ?? record.uri ?? '';
    if (record.utd !== uniformTypeDescriptor.UniformDataType.HYPERLINK) {
      return new SharedNote(content);
    }
    // URLExtractor.buildExternalLinkNote: "<title>\n\n[<url>]"
    const title: string = record.title ?? '';
    return new SharedNote((title === '' ? '' : title + '\n\n') + '[' + content + ']');
  }

  // MARK: - Loading Notes from a file (URLExtractor.loadNote)

  private async loadNote(uri: string): Promise<SharedNote | undefined> {
    const name: string = decodeURIComponent(uri.substring(uri.lastIndexOf('/') + 1));
    const ext: string = name.includes('.') ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : '';
    try {
      switch (ext) {
        case 'bearnote':
        case 'textpack':
          return await this.loadTextPack(uri, name);
        case 'textbundle':
          return ShareExtAbility.loadTextBundle(new fileUri.FileUri(uri).path);
        case 'text':
        case 'txt':
          return new SharedNote(ShareExtAbility.readText(uri));
        case 'markdown':
        case 'md':
          return new SharedNote(ShareExtAbility.readText(uri), true);
        default:
          return undefined;
      }
    } catch (e) {
      return undefined;
    }
  }

  /// loadTextPack: unzip into a temporary directory, then load the bundle inside it
  private async loadTextPack(uri: string, name: string): Promise<SharedNote | undefined> {
    const tmp: string = this.context.cacheDir + '/share-' + util.generateRandomUUID(false);
    fileIo.mkdirSync(tmp);
    try {
      const zipPath: string = tmp + '/' + name;
      const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      try {
        fileIo.copyFileSync(file.fd, zipPath);
      } finally {
        fileIo.closeSync(file);
      }
      const unzipped: string = tmp + '/unzipped';
      fileIo.mkdirSync(unzipped);
      await zlib.decompressFile(zipPath, unzipped);
      return ShareExtAbility.loadTextBundle(unzipped);
    } finally {
      fileIo.rmdirSync(tmp);
    }
  }

  /// loadTextBundle (TextBundleWrapper.textFileNameInFileWrapper): the bundle's "text.*" file, always Markdown.
  /// A textpack may hold the bundle folder itself, so one folder level below `dir` is searched too.
  private static loadTextBundle(dir: string): SharedNote | undefined {
    const files: string[] = fileIo.listFileSync(dir, { recursion: true });
    const textFile: string | undefined = files.find((path: string): boolean => {
      const parts: string[] = path.split('/').filter((part: string): boolean => part.length > 0);
      return parts.length <= 2 && parts[0] !== 'assets' && parts[parts.length - 1].toLowerCase().startsWith('text');
    });
    return textFile === undefined ? undefined : new SharedNote(ShareExtAbility.readText(dir + textFile), true);
  }

  /// String(contentsOf:) — UTF-8. `source` is a granted URI or a sandbox path.
  private static readText(source: string): string {
    const file: fileIo.File = fileIo.openSync(source, fileIo.OpenMode.READ_ONLY);
    try {
      const buffer: ArrayBuffer = new ArrayBuffer(fileIo.statSync(file.fd).size);
      fileIo.readSync(file.fd, buffer);
      return new util.TextDecoder('utf-8').decodeToString(new Uint8Array(buffer));
    } finally {
      fileIo.closeSync(file);
    }
  }
}
