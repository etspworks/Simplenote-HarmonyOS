// Port of SimplenoteFoundation-Swift: EntityObserver/EntityObserver.swift
// CoreData's NSManagedObjectContext + NSManagedObjectContextObjectsDidChange notification have no
// relationalStore equivalent, so ManagedObjectContext below is the notification half of it: the
// storage layer posts one ObjectsDidChange per saved change, carrying object identifiers (the
// NSManagedObjectID analogue: `<entityName>/<simperiumKey>`) under the CoreData userInfo keys.

export const NS_INSERTED_OBJECTS_KEY: string = 'inserted';
export const NS_UPDATED_OBJECTS_KEY: string = 'updated';
export const NS_DELETED_OBJECTS_KEY: string = 'deleted';
export const NS_REFRESHED_OBJECTS_KEY: string = 'refreshed';

export type ObjectsDidChangeUserInfo = Map<string, Set<string>>;

export class ObjectsDidChangeNotification {
  context: ManagedObjectContext;
  userInfo: ObjectsDidChangeUserInfo | null;

  constructor(context: ManagedObjectContext, userInfo: ObjectsDidChangeUserInfo | null) {
    this.context = context;
    this.userInfo = userInfo;
  }
}

export type ObjectsDidChangeHandler = (notification: ObjectsDidChangeNotification) => void;

export class ManagedObjectContext {
  private observers: Map<number, ObjectsDidChangeHandler> = new Map<number, ObjectsDidChangeHandler>();
  private nextToken: number = 1;

  /// NotificationCenter.addObserver(forName: .NSManagedObjectContextObjectsDidChange, object: context)
  addObserver(handler: ObjectsDidChangeHandler): number {
    const token: number = this.nextToken++;
    this.observers.set(token, handler);
    return token;
  }

  removeObserver(token: number): void {
    this.observers.delete(token);
  }

  /// Posted by the storage layer after every save / merge.
  postObjectsDidChange(userInfo: ObjectsDidChangeUserInfo): void {
    const notification: ObjectsDidChangeNotification = new ObjectsDidChangeNotification(this, userInfo);
    const handlers: ObjectsDidChangeHandler[] = Array.from(this.observers.values());
    for (const handler of handlers) {
      handler(notification);
    }
  }
}

export interface EntityObserverDelegate {
  entityObserver(observer: EntityObserver, identifiers: Set<string>): void;
}

/// Listens for changes applied over a set of object identifiers, and notifies its delegate whenever
/// any of the entities gets updated.
export class EntityObserver {
  /// NotificationCenter Observer Token.
  private notificationsToken: number = 0;
  private context: ManagedObjectContext;

  /// Identifiers of the objects being observed
  readonly observedIdentifiers: string[];

  /// Observed Change Types
  changeTypes: string[] = [NS_UPDATED_OBJECTS_KEY, NS_REFRESHED_OBJECTS_KEY];

  /// Invoked whenever any of the observed entities gets updated
  delegate: EntityObserverDelegate | null = null;

  constructor(context: ManagedObjectContext, identifiers: string[]) {
    this.context = context;
    this.observedIdentifiers = identifiers;
    this.notificationsToken = this.startListeningForNotifications(context);
  }

  /// Convenience Initializer: a single observed object identifier
  static forObject(context: ManagedObjectContext, identifier: string): EntityObserver {
    return new EntityObserver(context, [identifier]);
  }

  /// Stops listening (the Swift token is released on dealloc; ArkTS has no deinit, so owners call this).
  invalidate(): void {
    this.context.removeObserver(this.notificationsToken);
  }

  private startListeningForNotifications(context: ManagedObjectContext): number {
    return context.addObserver((note: ObjectsDidChangeNotification) => {
      this.contextDidChange(note);
    });
  }

  private contextDidChange(notification: ObjectsDidChangeNotification): void {
    const userInfo: ObjectsDidChangeUserInfo | null = notification.userInfo;
    const delegate: EntityObserverDelegate | null = this.delegate;
    if (userInfo === null || delegate === null) {
      return;
    }

    const extracted: Set<string> = this.extractObjectIdentifiers(userInfo, this.changeTypes);
    const updatedIdentifiers: Set<string> = new Set<string>();
    for (const identifier of this.observedIdentifiers) {
      if (extracted.has(identifier)) {
        updatedIdentifiers.add(identifier);
      }
    }
    if (updatedIdentifiers.size === 0) {
      return;
    }

    delegate.entityObserver(this, updatedIdentifiers);
  }

  /// Given a Notification's Payload, extracts the collection of identifiers stored under the specified keys.
  private extractObjectIdentifiers(userInfo: ObjectsDidChangeUserInfo, keys: string[]): Set<string> {
    const output: Set<string> = new Set<string>();
    for (const key of keys) {
      const objects: Set<string> | undefined = userInfo.get(key);
      if (objects === undefined) {
        continue;
      }
      objects.forEach((identifier: string) => {
        output.add(identifier);
      });
    }
    return output;
  }
}
