// Port of SPPinLockManager.swift, Classes/BiometricAuthentication.swift, Classes/KeychainManager.swift
// and the PinLock flows (PinLockBaseController / Setup / Remove / Verify).
// Keychain -> @kit.AssetStoreKit (via SPKeychain); LocalAuthentication -> @kit.UserAuthenticationKit;
// clock_gettime(CLOCK_MONOTONIC_RAW) -> systemDateTime.getUptime(STARTUP) (time since boot).
import { systemDateTime } from '@kit.BasicServicesKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { preferences } from '@kit.ArkData';
import { SPKeychain } from './simperium/Authenticator';
import { Options } from './OptionsStore';
import {
  PinLockControllerBase,
  PinLockControllerConfiguration,
  PinLockConfigurationObserver,
  PinLockReloadAnimation
} from '../model/PinLockControllerConfiguration';

const DOMAIN: number = 0x0000;
const LOG_TAG: string = 'PinLockManager';

/** SPConstants.m kPinTimeoutPreferencesKey */
export const PIN_TIMEOUT_PREFERENCES_KEY: string = 'kPinTimeoutPreferencesKey';
/** Seconds per timeout preference index (Off, 15s, 30s, 1m, 2m, 3m, 4m, 5m) */
export const PIN_TIMEOUT_VALUES: number[] = [0, 15, 30, 60, 120, 180, 240, 300];

// MARK: - Keychain Constants (SimplenoteKeychain)

export class SimplenoteKeychain {
  static readonly EXTENSION_ACCOUNT: string = 'Main';
  static readonly EXTENSION_SERVICE: string = 'SimplenoteShare';
  static readonly PINLOCK_ACCOUNT: string = 'SimplenotePin';
  static readonly PINLOCK_SERVICE: string = SimplenoteKeychain.PINLOCK_ACCOUNT;
  static readonly TIMESTAMP_ACCOUNT: string = 'Main';
  static readonly TIMESTAMP_SERVICE: string = 'simplenote-passcode';
}

// MARK: - KeychainManager (KeychainItemWrapper: nil deletes the item)

function writeKeychainItem(service: string, account: string, value: string | null): void {
  if (value === null) {
    SPKeychain.deletePasswordForService(service, account);
    return;
  }
  if (!SPKeychain.setPassword(value, service, account)) {
    hilog.error(DOMAIN, LOG_TAG, 'Error Setting Keychain Item %{public}s.%{public}s', service, account);
  }
}

export class KeychainManager {
  /** Simplenote's Share Extension Token */
  static get extensionToken(): string | null {
    return SPKeychain.passwordForService(SimplenoteKeychain.EXTENSION_SERVICE, SimplenoteKeychain.EXTENSION_ACCOUNT);
  }

  static set extensionToken(value: string | null) {
    writeKeychainItem(SimplenoteKeychain.EXTENSION_SERVICE, SimplenoteKeychain.EXTENSION_ACCOUNT, value);
  }

  /** Simplenote's PIN Lock Keychain Item */
  static get pinlock(): string | null {
    return SPKeychain.passwordForService(SimplenoteKeychain.PINLOCK_SERVICE, SimplenoteKeychain.PINLOCK_ACCOUNT);
  }

  static set pinlock(value: string | null) {
    writeKeychainItem(SimplenoteKeychain.PINLOCK_SERVICE, SimplenoteKeychain.PINLOCK_ACCOUNT, value);
  }

  /** Simplenote's Timestamp Keychain Item */
  static get timestamp(): string | null {
    return SPKeychain.passwordForService(SimplenoteKeychain.TIMESTAMP_SERVICE, SimplenoteKeychain.TIMESTAMP_ACCOUNT);
  }

  static set timestamp(value: string | null) {
    writeKeychainItem(SimplenoteKeychain.TIMESTAMP_SERVICE, SimplenoteKeychain.TIMESTAMP_ACCOUNT, value);
  }
}

// MARK: - BiometricAuthentication

export enum Biometry {
  TOUCH_ID = 0,
  FACE_ID = 1
}

const BIOMETRY_REASON: string = 'To unlock the application';
const BIOMETRY_TRUST_LEVEL: userAuth.AuthTrustLevel = userAuth.AuthTrustLevel.ATL2;

function isAuthTypeAvailable(authType: userAuth.UserAuthType): boolean {
  try {
    userAuth.getAvailableStatus(authType, BIOMETRY_TRUST_LEVEL);
    return true;
  } catch (e) {
    return false;
  }
}

export class BiometricAuthentication {
  /** Available biometry type or null if biometry is not supported or the user has none enrolled */
  get availableBiometry(): Biometry | null {
    if (isAuthTypeAvailable(userAuth.UserAuthType.FACE)) {
      return Biometry.FACE_ID;
    }
    if (isAuthTypeAvailable(userAuth.UserAuthType.FINGERPRINT)) {
      return Biometry.TOUCH_ID;
    }
    return null;
  }

  /** Evaluate biometry (system authentication widget) */
  evaluate(completion: (success: boolean) => void): void {
    if (this.availableBiometry === null) {
      completion(false);
      return;
    }
    const authParam: userAuth.AuthParam = {
      challenge: new Uint8Array(16),
      authType: [userAuth.UserAuthType.FACE, userAuth.UserAuthType.FINGERPRINT],
      authTrustLevel: BIOMETRY_TRUST_LEVEL
    };
    const widgetParam: userAuth.WidgetParam = { title: BIOMETRY_REASON };
    try {
      const instance: userAuth.UserAuthInstance = userAuth.getUserAuthInstance(authParam, widgetParam);
      const callback: userAuth.IAuthCallback = {
        onResult: (result: userAuth.UserAuthResult): void => {
          try {
            instance.off('result', callback);
          } finally {
            completion(result.result === userAuth.UserAuthResultCode.SUCCESS);
          }
        }
      };
      instance.on('result', callback);
      instance.start();
    } catch (e) {
      hilog.error(DOMAIN, LOG_TAG, 'Biometric evaluation failed: %{public}s', JSON.stringify(e));
      completion(false);
    }
  }
}

// MARK: - SPPinLockManager

export class SPPinLockManager {
  static readonly shared: SPPinLockManager = new SPPinLockManager();

  private readonly biometricAuthentication: BiometricAuthentication;

  constructor(biometricAuthentication: BiometricAuthentication = new BiometricAuthentication()) {
    this.biometricAuthentication = biometricAuthentication;
  }

  /** Running clock time of the device, in whole seconds since boot */
  private static nowSeconds(): number {
    return Math.max(0, Math.floor(systemDateTime.getUptime(systemDateTime.TimeType.STARTUP) / 1000));
  }

  /** Should we bypass pin lock due to timeout settings? */
  get shouldBypassPinLock(): boolean {
    const lastUsedSeconds: number = parseInt(KeychainManager.timestamp ?? '0', 10);
    if (isNaN(lastUsedSeconds) || lastUsedSeconds <= 0) {
      return false;
    }

    const maxTimeoutSeconds: number = this.pinLockTimeoutSeconds;
    // User has timeout set to 'Off' setting (0)
    if (maxTimeoutSeconds === 0) {
      return false;
    }

    const nowSeconds: number = SPPinLockManager.nowSeconds();
    // User may have recently rebooted their device, so we'll enforce lock screen
    if (lastUsedSeconds > nowSeconds) {
      return false;
    }

    const intervalSinceLastUsed: number = nowSeconds - lastUsedSeconds;
    return intervalSinceLastUsed < maxTimeoutSeconds;
  }

  private get pinLockTimeoutSeconds(): number {
    const store: preferences.Preferences | null = Options.shared.store;
    let timeoutPref: number = 0;
    if (store !== null) {
      const value: preferences.ValueType = store.getSync(PIN_TIMEOUT_PREFERENCES_KEY, 0);
      timeoutPref = typeof value === 'number' ? Math.trunc(value as number) : 0;
    }
    // The source guards with `>` count, so index == count would trap; treat it as Off.
    if (timeoutPref < 0 || timeoutPref >= PIN_TIMEOUT_VALUES.length) {
      return 0;
    }
    return PIN_TIMEOUT_VALUES[timeoutPref];
  }

  /** Store last time the app was used */
  storeLastUsedTime(): void {
    if (!this.isEnabled) {
      return;
    }
    KeychainManager.timestamp = SPPinLockManager.nowSeconds().toString();
  }

  /** Is pin enabled */
  get isEnabled(): boolean {
    const pin: string | null = this.pin;
    return pin !== null && pin.length > 0;
  }

  /** Set pin */
  setPin(pin: string): void {
    this.pin = pin;
  }

  /** Remove pin */
  removePin(): void {
    this.pin = null;
    this.shouldUseBiometry = false;
  }

  /** Check if provided pin is valid */
  validatePin(pin: string): boolean {
    return this.isEnabled && pin === this.pin;
  }

  private get pin(): string | null {
    return KeychainManager.pinlock;
  }

  private set pin(newValue: string | null) {
    KeychainManager.pinlock = newValue;
  }

  // MARK: - Biometry

  /** Should the app try to use biometry? */
  get shouldUseBiometry(): boolean {
    return Options.shared.useBiometryInsteadOfPin;
  }

  set shouldUseBiometry(newValue: boolean) {
    Options.shared.useBiometryInsteadOfPin = newValue;
  }

  get availableBiometry(): Biometry | null {
    return this.biometricAuthentication.availableBiometry;
  }

  evaluateBiometry(completion: (success: boolean) => void): void {
    if (!this.shouldUseBiometry) {
      completion(false);
      return;
    }
    this.biometricAuthentication.evaluate(completion);
  }
}

// MARK: - PinLockBaseController

function failedAttemptsMessage(attempts: number): string {
  return attempts > 1 ? `${attempts} Failed Passcode Attempts` : `${attempts} Failed Passcode Attempt`;
}

export abstract class PinLockBaseController extends PinLockControllerBase {
  /** Current configuration */
  configuration: PinLockControllerConfiguration = new PinLockControllerConfiguration('', null);

  /** Assigns the configuration observer and immediately publishes the current configuration (didSet) */
  setConfigurationObserver(observer: PinLockConfigurationObserver | null): void {
    this.configurationObserver = observer;
    if (observer !== null) {
      observer(this.configuration, null);
    }
  }

  /** Switch to another configuration with animation */
  switchTo(configuration: PinLockControllerConfiguration, animation: PinLockReloadAnimation): void {
    this.configuration = configuration;
    const observer: PinLockConfigurationObserver | null = this.configurationObserver;
    if (observer !== null) {
      observer(configuration, animation);
    }
  }

  /** Switch to failed attempt configuration */
  switchToFailedAttempt(title: string, attempts: number): void {
    this.switchTo(new PinLockControllerConfiguration(title, failedAttemptsMessage(attempts)),
      PinLockReloadAnimation.SHAKE);
  }
}

// MARK: - PinLockSetupController

export interface PinLockSetupControllerDelegate {
  pinLockSetupControllerDidComplete(controller: PinLockSetupController): void;
  pinLockSetupControllerDidCancel(controller: PinLockSetupController): void;
}

const CREATE_PASSCODE: string = 'Choose a 4 digit passcode';
const CONFIRM_PASSCODE: string = 'Confirm your passcode';
const PASSCODES_DONT_MATCH: string = 'Passcodes did not match. Try again.';

export class PinLockSetupController extends PinLockBaseController {
  private pin: string | null = null;
  private readonly pinLockManager: SPPinLockManager;
  private readonly delegate: PinLockSetupControllerDelegate;

  constructor(delegate: PinLockSetupControllerDelegate, pinLockManager: SPPinLockManager = SPPinLockManager.shared) {
    super();
    this.pinLockManager = pinLockManager;
    this.delegate = delegate;
    this.configuration = new PinLockControllerConfiguration(CREATE_PASSCODE, null);
  }

  get isCancellable(): boolean {
    return true;
  }

  handlePin(pin: string): void {
    if (pin.length === 0) {
      this.pin = null;
      this.switchTo(new PinLockControllerConfiguration(CREATE_PASSCODE, null), PinLockReloadAnimation.SHAKE);
      return;
    }
    const firstPin: string | null = this.pin;
    if (firstPin === null) {
      this.pin = pin;
      this.switchTo(new PinLockControllerConfiguration(CONFIRM_PASSCODE, null), PinLockReloadAnimation.SLIDE_LEADING);
      return;
    }
    if (pin !== firstPin) {
      this.pin = null;
      this.switchTo(new PinLockControllerConfiguration(CREATE_PASSCODE, PASSCODES_DONT_MATCH),
        PinLockReloadAnimation.SLIDE_TRAILING);
      return;
    }
    this.pinLockManager.setPin(pin);
    this.delegate.pinLockSetupControllerDidComplete(this);
  }

  handleCancellation(): void {
    this.delegate.pinLockSetupControllerDidCancel(this);
  }
}

// MARK: - PinLockRemoveController

export interface PinLockRemoveControllerDelegate {
  pinLockRemoveControllerDidComplete(controller: PinLockRemoveController): void;
  pinLockRemoveControllerDidCancel(controller: PinLockRemoveController): void;
}

const TURN_OFF_PASSCODE: string = 'Turn off Passcode';

export class PinLockRemoveController extends PinLockBaseController {
  private attempts: number = 1;
  private readonly pinLockManager: SPPinLockManager;
  private readonly delegate: PinLockRemoveControllerDelegate;

  constructor(delegate: PinLockRemoveControllerDelegate, pinLockManager: SPPinLockManager = SPPinLockManager.shared) {
    super();
    this.pinLockManager = pinLockManager;
    this.delegate = delegate;
    this.configuration = new PinLockControllerConfiguration(TURN_OFF_PASSCODE, null);
  }

  get isCancellable(): boolean {
    return true;
  }

  handlePin(pin: string): void {
    if (!this.pinLockManager.validatePin(pin)) {
      this.switchToFailedAttempt(TURN_OFF_PASSCODE, this.attempts);
      this.attempts += 1;
      return;
    }
    this.pinLockManager.removePin();
    this.delegate.pinLockRemoveControllerDidComplete(this);
  }

  handleCancellation(): void {
    this.delegate.pinLockRemoveControllerDidCancel(this);
  }
}

// MARK: - PinLockVerifyController

export interface PinLockVerifyControllerDelegate {
  pinLockVerifyControllerDidComplete(controller: PinLockVerifyController): void;
}

const ENTER_PASSCODE: string = 'Enter your passcode';

export class PinLockVerifyController extends PinLockBaseController {
  private attempts: number = 1;
  private hasShownBiometryVerification: boolean = false;
  private readonly pinLockManager: SPPinLockManager;
  /** ApplicationStateProvider: is the application in the foreground? */
  private readonly isApplicationActive: () => boolean;
  private readonly delegate: PinLockVerifyControllerDelegate;
  private onSuccessBlocks: Array<() => void> = [];

  constructor(delegate: PinLockVerifyControllerDelegate, isApplicationActive: () => boolean,
    pinLockManager: SPPinLockManager = SPPinLockManager.shared) {
    super();
    this.pinLockManager = pinLockManager;
    this.isApplicationActive = isApplicationActive;
    this.delegate = delegate;
    this.configuration = new PinLockControllerConfiguration(ENTER_PASSCODE, null);
  }

  get isCancellable(): boolean {
    return false;
  }

  handlePin(pin: string): void {
    if (!this.pinLockManager.validatePin(pin)) {
      this.switchToFailedAttempt(ENTER_PASSCODE, this.attempts);
      this.attempts += 1;
      return;
    }
    this.delegate.pinLockVerifyControllerDidComplete(this);
    this.runOnSuccessBlocks();
  }

  handleCancellation(): void {
    // Verification is not cancellable (isCancellable is false): the source ignores this event
    return;
  }

  viewDidAppear(): void {
    this.verifyBiometry();
  }

  applicationDidBecomeActive(): void {
    this.verifyBiometry();
  }

  addOnSuccesBlock(block: () => void): void {
    this.onSuccessBlocks.push(block);
  }

  removeSuccesBlocks(): void {
    this.onSuccessBlocks = [];
  }

  private runOnSuccessBlocks(): void {
    for (const block of this.onSuccessBlocks) {
      block();
    }
    this.removeSuccesBlocks();
  }

  private verifyBiometry(): void {
    if (!this.isApplicationActive() || this.hasShownBiometryVerification) {
      return;
    }
    this.hasShownBiometryVerification = true;
    this.pinLockManager.evaluateBiometry((success: boolean) => {
      if (success) {
        this.delegate.pinLockVerifyControllerDidComplete(this);
        this.runOnSuccessBlocks();
      }
    });
  }
}
