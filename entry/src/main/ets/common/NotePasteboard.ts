// Port of UIPasteboard+Note.swift. The link itself is computed by the Note model
// (Note+Links: markdownInternalLink / publicLink); callers pass that value here.
// Like the source's `guard let link ... else { return }`, a missing link copies nothing.
import { pasteboard } from '@kit.BasicServicesKit';

async function copyString(link: string | undefined): Promise<boolean> {
  if (link === undefined || link.length === 0) {
    return false;
  }
  const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, link);
  await pasteboard.getSystemPasteboard().setData(data);
  return true;
}

/** Copies the Internal Link (Markdown Reference, `[title](simplenote://note/<key>)`). */
export async function copyInternalLink(markdownInternalLink: string | undefined): Promise<boolean> {
  return copyString(markdownInternalLink);
}

/** Copies the Public Link (if any): simplenotePublishedBaseURL + publishURL, only when published. */
export async function copyPublicLink(publicLink: string | undefined): Promise<boolean> {
  return copyString(publicLink);
}
