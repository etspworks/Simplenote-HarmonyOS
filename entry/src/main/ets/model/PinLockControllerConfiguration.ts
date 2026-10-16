// Port of PinLock/PinLockController.swift: the configuration a PIN lock flow shows (title +
// optional message) and the PinLockController protocol its three flows (setup, remove, verify)
// implement. The default viewDidAppear / applicationDidBecomeActive do nothing, as in the source.

/** UIView.ReloadAnimation used when a configuration change is published */
export enum PinLockReloadAnimation {
  SLIDE_LEADING = 0,
  SLIDE_TRAILING = 1,
  SHAKE = 2
}

export class PinLockControllerConfiguration {
  /** PinLock screen title */
  title: string;
  /** PinLock screen message */
  message: string | null;

  constructor(title: string, message: string | null = null) {
    this.title = title;
    this.message = message;
  }

  /** Equatable */
  equals(other: PinLockControllerConfiguration): boolean {
    return this.title === other.title && this.message === other.message;
  }
}

export type PinLockConfigurationObserver =
  (configuration: PinLockControllerConfiguration, animation: PinLockReloadAnimation | null) => void;

/** PinLockController protocol */
export interface PinLockController {
  /** Observer for configuration changes. Provides updated configuration and optional animation */
  configurationObserver: PinLockConfigurationObserver | null;
  /** Is the flow cancellable? If so the screen shows a `cancel` button */
  readonly isCancellable: boolean;
  /** Handle pin entered in the screen */
  handlePin(pin: string): void;
  /** Handle tap on `cancel` */
  handleCancellation(): void;
  /** Handle view did appear event */
  viewDidAppear(): void;
  /** Handle application become active */
  applicationDidBecomeActive(): void;
}

/** Protocol-extension defaults: flows without work on these events extend this base. */
export abstract class PinLockControllerBase implements PinLockController {
  configurationObserver: PinLockConfigurationObserver | null = null;

  abstract get isCancellable(): boolean;

  abstract handlePin(pin: string): void;

  abstract handleCancellation(): void;

  viewDidAppear(): void {
    // Default implementation (protocol extension): nothing to do
    return;
  }

  applicationDidBecomeActive(): void {
    // Default implementation (protocol extension): nothing to do
    return;
  }
}
