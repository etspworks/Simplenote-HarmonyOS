// Port of Controllers/PublishController.swift: toggles a note's `published` system tag, saves,
// then listens (up to 5s) for the synced `publishURL` to arrive and reports each change.
import { Note } from '../model/Note';
import { SPAppDelegate } from './SessionStore';

class PublishConstants {
  static readonly TIME_OUT_MS: number = 5000;
  static readonly OBSERVED_PROPERTY: string = 'publishURL';
}

export class PublishController {
  /// SPAppDelegate.publishController (configurePublishController): one per app.
  static readonly shared: PublishController = new PublishController();

  private observedNotes: Map<string, Note> = new Map<string, Note>();

  onUpdate: ((note: Note) => void) | null = null;

  updatePublishState(note: Note, published: boolean): void {
    if (note.published === published) {
      return;
    }
    this.changePublishState(note, published);
    this.beginListeningForChanges(note, PublishConstants.TIME_OUT_MS);
    this.publishStateChanged(note);
  }

  private changePublishState(note: Note, published: boolean): void {
    note.published = published;
    note.modificationDate = new Date();
    SPAppDelegate.shared().save();
  }

  private publishStateChanged(note: Note): void {
    if (this.onUpdate !== null) {
      this.onUpdate(note);
    }
  }

  // MARK: Listeners

  private beginListeningForChanges(note: Note, timeOutMs: number): void {
    this.observedNotes.set(note.simperiumKey, note);
    setTimeout(() => {
      this.endListeningForChanges(note);
    }, timeOutMs);
  }

  private endListeningForChanges(note: Note): void {
    this.observedNotes.delete(note.simperiumKey);
  }

  // MARK: Listener Notifications (forwarded from the notes SPBucket delegate)

  didReceiveUpdateNotification(key: string, memberNames: string[]): void {
    const note: Note | undefined = this.observedNotes.get(key);
    if (memberNames.indexOf(PublishConstants.OBSERVED_PROPERTY) < 0 || note === undefined) {
      return;
    }
    this.publishStateChanged(note);
    this.endListeningForChanges(note);
  }

  didReceiveDeleteNotification(key: string): void {
    const note: Note | undefined = this.observedNotes.get(key);
    if (note === undefined) {
      return;
    }
    this.endListeningForChanges(note);
  }
}
