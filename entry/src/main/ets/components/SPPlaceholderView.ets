import { LengthMetrics } from '@kit.ArkUI';
// Port of SPPlaceholderView: the notes list's empty state.
//   generic         -> Simplenote logo only (indexing / signing out)
//   pictureAndText  -> filter glyph + message ('Create your first note', 'Your trash is empty', ...)
//   text            -> 'No Results' + tappable 'Create a new note titled "<query>"'
// The whole view is the tap target (UITapGestureRecognizer on the view); only `text` mode acts on it.
export enum PlaceholderMode {
  GENERIC = 0,
  PICTURE_AND_TEXT = 1,
  TEXT = 2
}

/// UIImageName values the list's placeholder uses.
export enum PlaceholderImage {
  ALL_NOTES = 'allNotes',
  TRASH = 'trash',
  UNTAGGED = 'untagged',
  TAG = 'tag'
}

/// SPPlaceholderView.Constants
const PLACEHOLDER_IMAGE_HEIGHT: number = 72;
const PLACEHOLDER_IMAGE_ALPHA: number = 0.5;
const SPACING_DEFAULT: number = 25;
const SPACING_CONDENSED: number = 5;

@Component
export struct SPPlaceholderView {
  @Prop mode: PlaceholderMode = PlaceholderMode.GENERIC;
  @Prop imageName: PlaceholderImage = PlaceholderImage.ALL_NOTES;
  @Prop text: string = '';
  @Prop actionText: string = '';
  onAction: (() => void) | null = null;

  private handleTap(): void {
    if (this.mode !== PlaceholderMode.TEXT || this.onAction === null) {
      return;
    }
    this.onAction();
  }

  @Builder
  picture() {
    if (this.mode === PlaceholderMode.GENERIC) {
      Image($r('app.media.simplenote_logo')).height(PLACEHOLDER_IMAGE_HEIGHT).width(PLACEHOLDER_IMAGE_HEIGHT).objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_placeholder_image')).opacity(PLACEHOLDER_IMAGE_ALPHA)
    } else if (this.imageName === PlaceholderImage.TRASH) {
      Image($r('app.media.ic_trash')).height(PLACEHOLDER_IMAGE_HEIGHT).width(PLACEHOLDER_IMAGE_HEIGHT).objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_placeholder_image')).opacity(PLACEHOLDER_IMAGE_ALPHA)
    } else if (this.imageName === PlaceholderImage.UNTAGGED) {
      Image($r('app.media.ic_untagged')).height(PLACEHOLDER_IMAGE_HEIGHT).width(PLACEHOLDER_IMAGE_HEIGHT).objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_placeholder_image')).opacity(PLACEHOLDER_IMAGE_ALPHA)
    } else if (this.imageName === PlaceholderImage.TAG) {
      Image($r('app.media.ic_tag')).height(PLACEHOLDER_IMAGE_HEIGHT).width(PLACEHOLDER_IMAGE_HEIGHT).objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_placeholder_image')).opacity(PLACEHOLDER_IMAGE_ALPHA)
    } else {
      Image($r('app.media.ic_allnotes')).height(PLACEHOLDER_IMAGE_HEIGHT).width(PLACEHOLDER_IMAGE_HEIGHT).objectFit(ImageFit.Contain)
        .fillColor($r('app.color.simplenote_placeholder_image')).opacity(PLACEHOLDER_IMAGE_ALPHA)
    }
  }

  build() {
    // stackView.spacing: 25 by default, 5 in text mode (title3 message + blue action line).
    Column({ space: this.mode === PlaceholderMode.TEXT ? SPACING_CONDENSED : SPACING_DEFAULT }) {
      if (this.mode !== PlaceholderMode.TEXT) {
        this.picture()
      }
      if (this.mode !== PlaceholderMode.GENERIC) {
        Text(this.text)
          .textAlign(TextAlign.Center)
          .fontSize(this.mode === PlaceholderMode.TEXT ? $r('sys.float.Title_S') : $r('sys.float.Body_L'))
          .fontColor($r('app.color.simplenote_placeholder_text'))
      }
      if (this.mode === PlaceholderMode.TEXT) {
        Text(this.actionText)
          .textAlign(TextAlign.Center)
          .fontSize($r('sys.float.Body_L'))
          .fontColor($r('app.color.simplenote_blue50'))
      }
    }
    .alignItems(HorizontalAlign.Center)
    .padding({ start: LengthMetrics.vp(32), end: LengthMetrics.vp(32) })
    .onClick(() => {
      this.handleTap();
    })
  }
}
