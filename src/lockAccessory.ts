import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { DanalockApiError, DanalockAuthError, type LockState } from './danalockApi.js';
import { DEFAULTS } from './settings.js';
import type { DanalockPlatform } from './platform.js';

export interface LockContext {
  serial: string;
  name: string;
}

/**
 * A single Danalock exposed as a HomeKit Lock Mechanism, with the battery reported as part of the
 * same accessory rather than a separate tile.
 */
export class DanalockLockAccessory {
  private readonly lockService: Service;
  private readonly batteryService?: Service;

  private currentState: LockState | null = null;
  private targetState: LockState | null = null;

  /** Consecutive failed state reads; drives the transition to "No Response". */
  private failureStreak = 0;
  private unresponsive = false;
  /** Ensures the escalation warning is logged once per outage, not once per poll. */
  private warnedUnresponsive = false;

  private batteryLevel: number | null = null;
  private batteryReadAt = 0;
  private batteryFailureStreak = 0;
  private warnedStaleBattery = false;

  /** Set while a user-initiated operation is running, so polling doesn't fight the command. */
  private operating = false;

  constructor(
    private readonly platform: DanalockPlatform,
    private readonly accessory: PlatformAccessory<LockContext>,
  ) {
    const { Characteristic, Service: HapService } = this.platform;

    this.accessory
      .getService(HapService.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Danalock')
      .setCharacteristic(Characteristic.Model, 'Danalock V3')
      .setCharacteristic(Characteristic.SerialNumber, this.serial);

    this.lockService =
      this.accessory.getService(HapService.LockMechanism) ??
      this.accessory.addService(HapService.LockMechanism);

    this.lockService.setCharacteristic(Characteristic.Name, this.displayName);

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => this.readCurrentState());

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.readTargetState())
      .onSet((value) => this.setTargetState(value));

    if (this.platform.options.showBattery) {
      this.batteryService =
        this.accessory.getService(HapService.Battery) ?? this.accessory.addService(HapService.Battery);

      this.batteryService.setCharacteristic(Characteristic.Name, `${this.displayName} Battery`);
      this.batteryService.setCharacteristic(
        Characteristic.ChargingState,
        Characteristic.ChargingState.NOT_CHARGEABLE,
      );

      // Linking keeps the battery presented as part of the lock instead of a standalone tile.
      this.lockService.addLinkedService(this.batteryService);

      this.batteryService.getCharacteristic(Characteristic.BatteryLevel).onGet(() => this.readBatteryLevel());
      this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.readLowBattery());
    } else {
      // Config changed since the accessory was cached — drop the stale service.
      const existing = this.accessory.getService(HapService.Battery);
      if (existing) {
        this.accessory.removeService(existing);
      }
    }
  }

  get serial(): string {
    return this.accessory.context.serial;
  }

  get displayName(): string {
    return this.accessory.context.name;
  }

  /** Identifies the lock in logs; with several locks the serial alone is hard to place. */
  private get label(): string {
    return `"${this.displayName}" (${this.serial})`;
  }

  // ---------------------------------------------------------------------------
  // HomeKit reads — always answered from cache; a bridge round-trip takes 5-7s and HomeKit
  // expects an immediate response.
  // ---------------------------------------------------------------------------

  private readCurrentState(): CharacteristicValue {
    this.assertResponsive();
    return this.toHapState(this.currentState);
  }

  private readTargetState(): CharacteristicValue {
    this.assertResponsive();
    const { Characteristic } = this.platform;
    const target = this.targetState ?? this.currentState;
    return target === 'Unlocked' ? Characteristic.LockTargetState.UNSECURED : Characteristic.LockTargetState.SECURED;
  }

  private readBatteryLevel(): CharacteristicValue {
    this.assertResponsive();
    return this.batteryLevel ?? 100;
  }

  private readLowBattery(): CharacteristicValue {
    this.assertResponsive();
    const { Characteristic } = this.platform;
    const level = this.batteryLevel;
    return level !== null && level <= this.platform.options.lowBatteryThreshold
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  /**
   * Once the lock's state can no longer be verified, report "No Response" rather than continuing
   * to assert a stale value. A lock shown as Locked when it may be open is a safety problem, not
   * just a stale reading.
   */
  private assertResponsive(): void {
    if (this.unresponsive) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private toHapState(state: LockState | null): CharacteristicValue {
    const { Characteristic } = this.platform;
    switch (state) {
      case 'Locked':
        return Characteristic.LockCurrentState.SECURED;
      case 'Unlocked':
        return Characteristic.LockCurrentState.UNSECURED;
      default:
        // The bridge answered but the state was unrecognised — distinct from being unreachable.
        return Characteristic.LockCurrentState.UNKNOWN;
    }
  }

  // ---------------------------------------------------------------------------
  // HomeKit writes
  // ---------------------------------------------------------------------------

  /**
   * Accepts the request and returns immediately — it must NOT wait for the lock.
   *
   * HomeKit allows a write handler 3s before warning and 9s in total before it gives up with
   * OPERATION_TIMED_OUT and paints the accessory "No Response" (see Accessory.TIMEOUT_WARNING and
   * TIMEOUT_AFTER_WARNING in hap-nodejs). A Danalock operation takes 5-7s on its own, more when it
   * queues behind a poll, so awaiting it here reliably blew that budget.
   *
   * Returning straight away also gives the correct HomeKit behaviour for a slow lock: while the
   * current state differs from the target, the Home app shows "Locking…" / "Unlocking…".
   */
  private setTargetState(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    const wantLocked = value === Characteristic.LockTargetState.SECURED;
    const desired: LockState = wantLocked ? 'Locked' : 'Unlocked';

    if (this.operating) {
      this.platform.log.warn(`Ignoring ${desired.toLowerCase()} request for ${this.label}: an operation is already running.`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_BUSY);
    }

    this.operating = true;
    this.targetState = desired;

    // Deliberately not awaited: the handler returns now, the lock catches up.
    void this.runOperation(desired, wantLocked);
  }

  /** Performs the operation in the background and reconciles state when it settles. */
  private async runOperation(desired: LockState, wantLocked: boolean): Promise<void> {
    try {
      this.platform.log.info(`${wantLocked ? 'Locking' : 'Unlocking'} ${this.label}...`);
      await this.platform.api2.operate(this.serial, wantLocked ? 'lock' : 'unlock');

      this.currentState = desired;
      this.clearFailureStreak();
      this.publishState();
      this.platform.log.info(`${this.label} is now ${desired.toLowerCase()}.`);

      // Confirm against the lock shortly after, in case it did not physically complete.
      this.platform.scheduleConfirmation(this);
    } catch (error) {
      // A command the user explicitly issued failed — always surface it, never swallow. The write
      // handler has already returned, so this cannot be reported by throwing; instead the target
      // snaps back to the real state and the failure is logged.
      this.platform.log.error(
        `Failed to ${wantLocked ? 'lock' : 'unlock'} ${this.label}: ${describe(error)}. The door has NOT been ${desired.toLowerCase()}.`,
      );
      this.targetState = this.currentState;
      this.publishState();

      // Re-read rather than trusting the assumption that nothing moved.
      this.operating = false;
      await this.refresh();
    } finally {
      this.operating = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /** Refreshes state (and battery when due) from the lock. Never throws. */
  async refresh(): Promise<void> {
    if (this.operating) {
      this.platform.log.debug(`Skipping poll for ${this.label}: operation in progress.`);
      return;
    }

    await this.refreshState();

    if (this.batteryService && this.isBatteryDue()) {
      await this.refreshBattery();
    }
  }

  private async refreshState(): Promise<void> {
    try {
      const state = await this.platform.api2.getState(this.serial);
      const previous = this.currentState;
      this.currentState = state;

      if (state !== null && this.targetState !== state && !this.operating) {
        // Keep the target aligned with reality so the UI doesn't sit on an unfulfilled target.
        this.targetState = state;
      }

      this.clearFailureStreak();
      this.publishState();

      if (previous !== null && state !== null && previous !== state) {
        this.platform.log.info(`${this.label} changed to ${state.toLowerCase()} (changed outside HomeKit).`);
      }
    } catch (error) {
      this.recordStateFailure(error);
    }
  }

  private async refreshBattery(): Promise<void> {
    try {
      const level = await this.platform.api2.getBattery(this.serial);
      if (level === null) {
        return;
      }

      this.batteryLevel = level;
      this.batteryReadAt = Date.now();
      this.batteryFailureStreak = 0;
      this.warnedStaleBattery = false;

      const { Characteristic } = this.platform;
      this.batteryService?.updateCharacteristic(Characteristic.BatteryLevel, level);
      this.batteryService?.updateCharacteristic(
        Characteristic.StatusLowBattery,
        level <= this.platform.options.lowBatteryThreshold
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      this.platform.log.debug(`${this.label} battery: ${level}%.`);
    } catch (error) {
      this.batteryFailureStreak++;
      const known = this.batteryLevel === null ? 'no previous reading' : `keeping last known value (${this.batteryLevel}%)`;

      if (this.batteryFailureStreak >= this.platform.options.unresponsiveThreshold) {
        this.platform.log.warn(
          `Battery level unavailable for ${this.label} after ${this.batteryFailureStreak} attempts: ${describe(error)}; ${known}.`,
        );
      } else {
        this.platform.log.debug(`Battery read failed for ${this.label}: ${describe(error)}; ${known}.`);
      }

      // Don't let a stale figure masquerade as current indefinitely.
      if (
        this.batteryLevel !== null &&
        !this.warnedStaleBattery &&
        Date.now() - this.batteryReadAt > DEFAULTS.staleBatteryWarnMs
      ) {
        this.warnedStaleBattery = true;
        this.platform.log.warn(
          `${this.label} battery level has not been readable for over 24 hours; the reported ${this.batteryLevel}% is stale.`,
        );
      }
    }
  }

  private isBatteryDue(): boolean {
    return Date.now() - this.batteryReadAt >= this.platform.options.batteryPollInterval * 1000;
  }

  private recordStateFailure(error: unknown): void {
    this.failureStreak++;
    const threshold = this.platform.options.unresponsiveThreshold;

    if (error instanceof DanalockAuthError) {
      // Credentials are actionable and won't fix themselves — always an error.
      this.platform.log.error(`Authentication failed while polling ${this.label}: ${describe(error)}`);
    } else if (this.failureStreak < threshold) {
      // Timeouts are routine on this transport; stay quiet until it looks like a real outage.
      this.platform.log.debug(
        `State read ${this.failureStreak}/${threshold} failed for ${this.label}: ${describe(error)}; keeping last known state.`,
      );
    } else if (!this.warnedUnresponsive) {
      this.warnedUnresponsive = true;
      this.platform.log.warn(
        `${this.label} has failed ${this.failureStreak} consecutive state reads: ${describe(error)}. ` +
          'Showing it as "No Response" in the Home app rather than reporting a state that can no longer be verified. ' +
          'Check the Danabridge is powered, online, and within Bluetooth range of the lock.',
      );
    }

    if (this.failureStreak >= threshold && !this.unresponsive) {
      this.unresponsive = true;
      this.markUnresponsive();
    }
  }

  private clearFailureStreak(): void {
    const wasUnresponsive = this.unresponsive;
    this.failureStreak = 0;
    this.unresponsive = false;

    if (wasUnresponsive) {
      // Close the loop, otherwise the log leaves the impression it is still broken.
      this.platform.log.info(`${this.label} is responding again.`);
      this.warnedUnresponsive = false;
    }
  }

  /** Pushes an error to the characteristics so the Home app shows "No Response". */
  private markUnresponsive(): void {
    const { Characteristic } = this.platform;
    const error = new Error('Danalock unreachable');

    this.lockService.updateCharacteristic(Characteristic.LockCurrentState, error);
    this.lockService.updateCharacteristic(Characteristic.LockTargetState, error);

    if (this.batteryService) {
      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, error);
      this.batteryService.updateCharacteristic(Characteristic.StatusLowBattery, error);
    }
  }

  private publishState(): void {
    const { Characteristic } = this.platform;
    this.lockService.updateCharacteristic(Characteristic.LockCurrentState, this.toHapState(this.currentState));

    const target = this.targetState ?? this.currentState;
    if (target) {
      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState,
        target === 'Unlocked' ? Characteristic.LockTargetState.UNSECURED : Characteristic.LockTargetState.SECURED,
      );
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof DanalockApiError || error instanceof DanalockAuthError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}
