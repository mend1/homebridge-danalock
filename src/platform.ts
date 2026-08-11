import type {
  API,
  Characteristic as CharacteristicClass,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service as ServiceClass,
} from 'homebridge';

import { DanalockApiClient, type DanalockLock } from './danalockApi.js';
import { DanalockLockAccessory, type LockContext } from './lockAccessory.js';
import { DEFAULTS, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface LockFilterEntry {
  identifier?: string;
  exclude?: boolean;
}

export interface DanalockConfig extends PlatformConfig {
  username?: string;
  password?: string;
  pollInterval?: number;
  batteryPollInterval?: number;
  showBattery?: boolean;
  lowBatteryThreshold?: number;
  unresponsiveThreshold?: number;
  locks?: LockFilterEntry[];
}

export interface ResolvedOptions {
  pollInterval: number;
  batteryPollInterval: number;
  showBattery: boolean;
  lowBatteryThreshold: number;
  unresponsiveThreshold: number;
}

export class DanalockPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof ServiceClass;
  readonly Characteristic: typeof CharacteristicClass;

  /** The Danalock API client. Named `api2` to avoid colliding with Homebridge's `api`. */
  readonly api2: DanalockApiClient;

  readonly options: ResolvedOptions;

  private readonly cachedAccessories: PlatformAccessory<LockContext>[] = [];
  private readonly locks = new Map<string, DanalockLockAccessory>();

  private pollTimer?: NodeJS.Timeout;
  private summaryTimer?: NodeJS.Timeout;
  private readonly confirmationTimers = new Set<NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(
    readonly log: Logger,
    readonly config: DanalockConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.options = this.resolveOptions(config);

    if (!config.username || !config.password) {
      this.log.error(
        'Danalock username and password are required. Set them in the Homebridge UI; the platform will stay idle until then.',
      );
      // Construct a client anyway so the object is well-formed, but never start polling.
      this.api2 = new DanalockApiClient('', '', this.log);
      return;
    }

    this.api2 = new DanalockApiClient(config.username, config.password, this.log);
    // One background operation per bridge per poll interval, whatever asked for it. This is the
    // ceiling that keeps the bridge usable by the Danalock app.
    this.api2.setMinOperationGap(this.options.pollInterval * 1000);

    this.api.on('didFinishLaunching', () => {
      void this.discoverLocks();
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
      }
      if (this.summaryTimer) {
        clearInterval(this.summaryTimer);
      }
      for (const timer of this.confirmationTimers) {
        clearTimeout(timer);
      }
      this.confirmationTimers.clear();
    });
  }

  /** Clamps user-supplied timings to safe floors so a misconfiguration can't flood the bridge. */
  private resolveOptions(config: DanalockConfig): ResolvedOptions {
    const clamp = (value: number | undefined, fallback: number, min: number, label: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
      }
      if (value < min) {
        this.log.warn(`${label} of ${value}s is below the ${min}s minimum; using ${min}s. Lower values only cause bridge errors.`);
        return min;
      }
      return value;
    };

    return {
      pollInterval: clamp(config.pollInterval, DEFAULTS.pollInterval, DEFAULTS.minPollInterval, 'Poll interval'),
      batteryPollInterval: clamp(
        config.batteryPollInterval,
        DEFAULTS.batteryPollInterval,
        DEFAULTS.minBatteryPollInterval,
        'Battery poll interval',
      ),
      showBattery: config.showBattery !== false,
      lowBatteryThreshold: config.lowBatteryThreshold ?? DEFAULTS.lowBatteryThreshold,
      unresponsiveThreshold: Math.max(1, config.unresponsiveThreshold ?? DEFAULTS.unresponsiveThreshold),
    };
  }

  /** Homebridge restores cached accessories through this before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory<LockContext>): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  private async discoverLocks(): Promise<void> {
    let discovered: DanalockLock[];
    try {
      discovered = await this.api2.getLocks();
    } catch (error) {
      this.log.error(`Could not retrieve locks from Danalock: ${describe(error)}`);
      this.log.error('Check the account credentials and internet connection, then restart Homebridge.');
      return;
    }

    const selected = discovered.filter((lock) => this.isSelected(lock));
    if (selected.length === 0) {
      this.log.warn('No Danalocks to expose. Check the account has locks and that the lock filter is not excluding them all.');
      return;
    }

    this.log.info(`Discovered ${selected.length} lock(s): ${selected.map((lock) => lock.name).join(', ')}`);

    // Resolve each lock's Danabridge so operations queue per bridge. Locks behind different
    // bridges then run in parallel, while locks sharing one bridge serialise correctly.
    await Promise.all(selected.map((lock) => this.mapBridge(lock)));

    for (const lock of selected) {
      this.registerLock(lock);
    }

    this.pruneStaleAccessories(selected);
    this.startPolling();
  }

  private isSelected(lock: DanalockLock): boolean {
    const filters = this.config.locks;
    if (!Array.isArray(filters) || filters.length === 0) {
      return true;
    }

    const matches = (entry: LockFilterEntry): boolean => {
      const id = entry.identifier?.trim().toLowerCase();
      return !!id && (id === lock.name.toLowerCase() || id === lock.serial.toLowerCase());
    };

    if (filters.some((entry) => entry.exclude && matches(entry))) {
      return false;
    }

    const includes = filters.filter((entry) => !entry.exclude && entry.identifier?.trim());
    return includes.length === 0 || includes.some(matches);
  }

  private async mapBridge(lock: DanalockLock): Promise<void> {
    try {
      const bridge = await this.api2.getPairedBridge(lock.serial);
      if (bridge) {
        this.api2.setBridgeForLock(lock.serial, bridge);
        this.log.debug(`"${lock.name}" (${lock.serial}) is paired with Danabridge ${bridge}.`);
        return;
      }
      this.warnBridgeFallback(lock, 'no Danabridge is listed as paired with it');
    } catch (error) {
      this.warnBridgeFallback(lock, describe(error));
    }
  }

  /**
   * Falling back to the shared queue is a silent performance regression — locks that could run in
   * parallel now serialise — so it is warned about rather than buried in debug output.
   */
  private warnBridgeFallback(lock: DanalockLock, reason: string): void {
    this.api2.setBridgeForLock(lock.serial, null);
    this.log.warn(
      `Could not determine the Danabridge paired with "${lock.name}" (${lock.serial}): ${reason}. ` +
        'Falling back to a shared serialised queue — operations for this lock will not run in parallel with other locks. ' +
        'Check the lock is paired to a Danabridge in the Danalock app.',
    );
  }

  private registerLock(lock: DanalockLock): void {
    const uuid = this.api.hap.uuid.generate(lock.serial);
    const cached = this.cachedAccessories.find((accessory) => accessory.UUID === uuid);

    if (cached) {
      cached.context.serial = lock.serial;
      cached.context.name = lock.name;
      cached.displayName = lock.name;
      this.api.updatePlatformAccessories([cached]);
      this.locks.set(lock.serial, new DanalockLockAccessory(this, cached));
      this.log.debug(`Restored "${lock.name}".`);
      return;
    }

    const accessory = new this.api.platformAccessory<LockContext>(lock.name, uuid);
    accessory.context = { serial: lock.serial, name: lock.name };
    this.locks.set(lock.serial, new DanalockLockAccessory(this, accessory));
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.info(`Added "${lock.name}".`);
  }

  private pruneStaleAccessories(selected: DanalockLock[]): void {
    const keep = new Set(selected.map((lock) => this.api.hap.uuid.generate(lock.serial)));
    const stale = this.cachedAccessories.filter((accessory) => !keep.has(accessory.UUID));

    if (stale.length > 0) {
      const names = stale.map((accessory) => accessory.displayName).join(', ');
      this.log.info(`Removing ${stale.length} accessory/accessories no longer on the account: ${names}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Self-scheduling loop: the next round is queued only once the previous one settles, so slow
   * round-trips stretch the interval instead of stacking up requests. The configured interval is
   * the gap between rounds, not a guaranteed frequency.
   */
  private startPolling(): void {
    const tick = async (): Promise<void> => {
      if (this.shuttingDown) {
        return;
      }

      // Dispatch every lock at once; the per-bridge queues decide what truly runs in parallel.
      await Promise.all([...this.locks.values()].map((lock) => lock.refresh()));

      if (!this.shuttingDown) {
        this.pollTimer = setTimeout(() => void tick(), this.options.pollInterval * 1000);
      }
    };

    this.log.debug(`Polling lock state every ${this.options.pollInterval}s.`);
    void tick();
    this.startSummaries();
  }

  /**
   * Periodic per-bridge rollup. A single unhealthy Danabridge is hard to see in a stream of
   * individual failures but obvious next to a healthy one's numbers.
   */
  private startSummaries(): void {
    this.summaryTimer = setInterval(() => {
      for (const line of this.api2.drainBridgeSummary()) {
        this.log.debug(line);
      }
    }, DEFAULTS.summaryIntervalMs);

    // Never hold the process open for a logging timer.
    this.summaryTimer.unref?.();
  }

  /**
   * After a command, re-read the lock shortly afterwards to confirm it physically completed —
   * the bridge reporting success does not guarantee the bolt moved.
   */
  scheduleConfirmation(lock: DanalockLockAccessory): void {
    if (this.shuttingDown) {
      return;
    }

    const timer = setTimeout(() => {
      this.confirmationTimers.delete(timer);
      void lock.refresh();
    }, 5_000);

    this.confirmationTimers.add(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
