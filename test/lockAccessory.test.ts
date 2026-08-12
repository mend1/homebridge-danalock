import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DanalockLockAccessory, type LockContext } from '../src/lockAccessory.js';
import type { DanalockPlatform } from '../src/platform.js';

/**
 * Minimal HAP stand-ins. Characteristic/Service constants double as map keys (object identity)
 * and as value holders, matching how the real HAP types are used.
 */
const constant = <T extends object>(values: T) => Object.assign({}, values);

const Characteristic = {
  Name: constant({}),
  Manufacturer: constant({}),
  Model: constant({}),
  SerialNumber: constant({}),
  LockCurrentState: constant({ UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 }),
  LockTargetState: constant({ UNSECURED: 0, SECURED: 1 }),
  BatteryLevel: constant({}),
  StatusLowBattery: constant({ BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }),
  ChargingState: constant({ NOT_CHARGEABLE: 2 }),
};

const Service = {
  AccessoryInformation: constant({}),
  LockMechanism: constant({}),
  Battery: constant({}),
};

const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402, RESOURCE_BUSY: -70403 };

class HapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HAP status ${hapStatus}`);
  }
}

class FakeCharacteristic {
  value: unknown = null;
  getHandler?: () => unknown;
  setHandler?: (value: unknown) => Promise<void> | void;

  onGet(handler: () => unknown): this {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: (value: unknown) => Promise<void> | void): this {
    this.setHandler = handler;
    return this;
  }
}

class FakeService {
  readonly characteristics = new Map<object, FakeCharacteristic>();
  readonly linked: FakeService[] = [];

  getCharacteristic(key: object): FakeCharacteristic {
    let existing = this.characteristics.get(key);
    if (!existing) {
      existing = new FakeCharacteristic();
      this.characteristics.set(key, existing);
    }
    return existing;
  }

  setCharacteristic(key: object, value: unknown): this {
    this.getCharacteristic(key).value = value;
    return this;
  }

  updateCharacteristic(key: object, value: unknown): this {
    this.getCharacteristic(key).value = value;
    return this;
  }

  addLinkedService(service: FakeService): void {
    this.linked.push(service);
  }
}

class FakeAccessory {
  readonly services = new Map<object, FakeService>();
  displayName = 'Lock One';

  constructor(public context: LockContext) {
    this.services.set(Service.AccessoryInformation, new FakeService());
  }

  getService(key: object): FakeService | undefined {
    return this.services.get(key);
  }

  addService(key: object): FakeService {
    const service = new FakeService();
    this.services.set(key, service);
    return service;
  }

  removeService(service: FakeService): void {
    for (const [key, value] of this.services) {
      if (value === service) {
        this.services.delete(key);
      }
    }
  }
}

interface Harness {
  accessory: DanalockLockAccessory;
  lockService: FakeService;
  logs: { level: string; message: string }[];
  api2: {
    getState: () => Promise<'Locked' | 'Unlocked' | null>;
    getBattery: () => Promise<number | null>;
    operate: () => Promise<void>;
  };
}

function buildHarness(options: {
  getState: () => Promise<'Locked' | 'Unlocked' | null>;
  operate?: () => Promise<void>;
  getBattery?: () => Promise<number | null>;
  unresponsiveThreshold?: number;
  showBattery?: boolean;
  batteryPollInterval?: number;
}): Harness {
  const logs: { level: string; message: string }[] = [];
  const record = (level: string) => (message: string) => logs.push({ level, message });

  const api2 = {
    getState: options.getState,
    getBattery: options.getBattery ?? (async () => null),
    operate: options.operate ?? (async () => undefined),
  };

  const platform = {
    Service,
    Characteristic,
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    api: { hap: { HapStatusError, HAPStatus } },
    api2,
    options: {
      pollInterval: 10,
      batteryPollInterval: options.batteryPollInterval ?? 3600,
      showBattery: options.showBattery ?? false,
      lowBatteryThreshold: 20,
      unresponsiveThreshold: options.unresponsiveThreshold ?? 3,
    },
    scheduleConfirmation: () => undefined,
  } as unknown as DanalockPlatform;

  const fakeAccessory = new FakeAccessory({ serial: '11:11:11:11:11:11', name: 'Lock One' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessory = new DanalockLockAccessory(platform, fakeAccessory as any);

  return { accessory, lockService: fakeAccessory.getService(Service.LockMechanism)!, logs, api2 };
}

const readCurrentState = (harness: Harness): unknown =>
  harness.lockService.getCharacteristic(Characteristic.LockCurrentState).getHandler!();

const readTargetState = (harness: Harness): unknown =>
  harness.lockService.getCharacteristic(Characteristic.LockTargetState).getHandler!();

/** Invokes the HomeKit write handler exactly as HAP would. */
const writeTargetState = (harness: Harness, value: number): Promise<void> | void =>
  harness.lockService.getCharacteristic(Characteristic.LockTargetState).setHandler!(value) as Promise<void> | void;

describe('state polling failures', () => {
  it('keeps the last known state through isolated failures', async () => {
    let shouldFail = false;
    const harness = buildHarness({
      getState: async () => {
        if (shouldFail) {
          throw new Error('timed out');
        }
        return 'Locked';
      },
    });

    await harness.accessory.refresh();
    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.SECURED);

    // Two failures is below the threshold of three — routine timeouts must not trip it.
    shouldFail = true;
    await harness.accessory.refresh();
    await harness.accessory.refresh();

    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.SECURED);
    assert.equal(harness.logs.filter((entry) => entry.level === 'warn').length, 0, 'should stay quiet below the threshold');
  });

  it('stops asserting a stale state once the lock is unreachable', async () => {
    let shouldFail = false;
    const harness = buildHarness({
      getState: async () => {
        if (shouldFail) {
          throw new Error('bridge offline');
        }
        return 'Locked';
      },
    });

    await harness.accessory.refresh();
    shouldFail = true;
    for (let i = 0; i < 3; i++) {
      await harness.accessory.refresh();
    }

    // Reporting "Locked" here would be a safety problem: the door may well be open.
    assert.throws(() => readCurrentState(harness), HapStatusError);

    const warnings = harness.logs.filter((entry) => entry.level === 'warn');
    assert.equal(warnings.length, 1, 'should warn exactly once per outage, not once per poll');
    assert.match(warnings[0].message, /No Response/);
  });

  it('recovers and reports the real state again', async () => {
    let shouldFail = true;
    const harness = buildHarness({
      getState: async () => {
        if (shouldFail) {
          throw new Error('bridge offline');
        }
        return 'Unlocked';
      },
    });

    for (let i = 0; i < 3; i++) {
      await harness.accessory.refresh();
    }
    assert.throws(() => readCurrentState(harness), HapStatusError);

    shouldFail = false;
    await harness.accessory.refresh();

    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.UNSECURED);
    assert.ok(
      harness.logs.some((entry) => entry.level === 'info' && /responding again/.test(entry.message)),
      'recovery should be logged so the log does not imply it is still broken',
    );
  });

  it('reports UNKNOWN rather than No Response when the bridge answers with a bad state', async () => {
    const harness = buildHarness({ getState: async () => null });

    for (let i = 0; i < 3; i++) {
      await harness.accessory.refresh();
    }

    // The bridge replied, so this is lock ambiguity, not a communication failure.
    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.UNKNOWN);
  });
});

describe('circuit breaker', () => {
  /**
   * The 14-hour outage produced roughly ten thousand pointless requests. After a handful of
   * failures the plugin should stop polling on the normal cadence and probe occasionally instead.
   */
  it('stops scheduled polling once a lock has clearly failed', async () => {
    let reads = 0;
    const harness = buildHarness({
      getState: async () => {
        reads++;
        throw new Error('BridgeNotAttached');
      },
    });

    for (let i = 0; i < 30; i++) {
      await harness.accessory.refresh();
    }

    // 5 failures open the breaker; the rest are suppressed until the first probe is due.
    assert.equal(reads, 5, `expected polling to stop after the breaker opened (got ${reads} reads)`);
    assert.ok(
      harness.logs.some((entry) => entry.level === 'warn' && /Pausing scheduled polling/.test(entry.message)),
      'opening the breaker should be logged',
    );
  });

  /**
   * The breaker must not open before the lock is showing "No Response". Once it does, the failure
   * count only advances on probes that back off to 30 minutes, so a higher unresponsiveThreshold
   * would leave HomeKit asserting a confident, unverifiable state for a very long time.
   */
  it('never pauses polling before the lock is marked unresponsive', async () => {
    let reads = 0;
    const harness = buildHarness({
      // Higher than the breaker's own threshold of 5.
      unresponsiveThreshold: 8,
      getState: async () => {
        reads++;
        throw new Error('BridgeNotAttached');
      },
    });

    for (let i = 0; i < 30; i++) {
      await harness.accessory.refresh();
    }

    assert.equal(reads, 8, `polling should continue until the unresponsive threshold (got ${reads} reads)`);
    // By the time polling pauses, HomeKit is already being told the state cannot be verified.
    assert.throws(() => readCurrentState(harness), HapStatusError);
    assert.ok(
      harness.logs.some((entry) => entry.level === 'warn' && /Pausing scheduled polling/.test(entry.message)),
      'the breaker should still open, just not before the lock is unresponsive',
    );
  });

  it('resumes normal polling as soon as a probe succeeds', async () => {
    let failing = true;
    let reads = 0;
    const harness = buildHarness({
      getState: async () => {
        reads++;
        if (failing) {
          throw new Error('BridgeNotAttached');
        }
        return 'Locked';
      },
    });

    for (let i = 0; i < 10; i++) {
      await harness.accessory.refresh();
    }
    assert.equal(reads, 5, 'polling should be paused');

    // A HomeKit read brings the probe forward, standing in for the elapsed backoff. The read
    // itself still throws, because the lock is showing as unresponsive — the probe is requested
    // before that check, which is the point.
    failing = false;
    try {
      harness.lockService.getCharacteristic(Characteristic.LockCurrentState).getHandler!();
    } catch {
      // expected
    }
    await harness.accessory.refresh();

    assert.equal(reads, 6, 'the probe should have gone out');
    assert.ok(
      harness.logs.some((entry) => entry.level === 'info' && /Resuming normal polling/.test(entry.message)),
      'recovery should be logged',
    );

    // ...and the cadence is back to normal.
    await harness.accessory.refresh();
    assert.equal(reads, 7);
  });

  it('deduplicates probes across the characteristics read in one Home app open', async () => {
    let reads = 0;
    const harness = buildHarness({
      getState: async () => {
        reads++;
        throw new Error('BridgeNotAttached');
      },
    });

    for (let i = 0; i < 10; i++) {
      await harness.accessory.refresh();
    }
    assert.equal(reads, 5);

    // Opening the Home app reads several characteristics on this accessory.
    for (let i = 0; i < 4; i++) {
      try {
        harness.lockService.getCharacteristic(Characteristic.LockCurrentState).getHandler!();
      } catch {
        // Expected: the lock is unresponsive, so the read throws.
      }
    }
    await harness.accessory.refresh();

    assert.equal(reads, 6, 'four reads should bring forward one probe, not four');
  });

  it('still attempts a user command while polling is paused, and resumes on success', async () => {
    let stateFailing = true;
    const harness = buildHarness({
      getState: async () => {
        if (stateFailing) {
          throw new Error('BridgeNotAttached');
        }
        return 'Locked';
      },
      operate: async () => undefined,
    });

    for (let i = 0; i < 10; i++) {
      await harness.accessory.refresh();
    }

    // The door must still be operable when the plugin has stopped polling.
    stateFailing = false;
    await writeTargetState(harness, Characteristic.LockTargetState.SECURED);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.SECURED);
    assert.ok(
      harness.logs.some((entry) => entry.level === 'info' && /Resuming normal polling/.test(entry.message)),
      'a successful command should resume polling',
    );
  });
});

describe('operating the lock from HomeKit', () => {
  /**
   * HomeKit gives a write handler 3s before warning and 9s before it gives up with
   * OPERATION_TIMED_OUT and shows "No Response" (hap-nodejs Accessory.TIMEOUT_WARNING /
   * TIMEOUT_AFTER_WARNING). A Danalock operation takes 5-7s, so the handler must not wait for it.
   */
  it('returns to HomeKit immediately instead of waiting for the lock', async () => {
    let releaseOperation: (() => void) | undefined;
    const operationStarted = { value: false };

    const harness = buildHarness({
      getState: async () => 'Unlocked',
      operate: () =>
        new Promise<void>((resolve) => {
          operationStarted.value = true;
          releaseOperation = resolve;
        }),
    });

    // Establish a known starting state, as a real poll would.
    await harness.accessory.refresh();

    const started = Date.now();
    await writeTargetState(harness, Characteristic.LockTargetState.SECURED);
    const elapsed = Date.now() - started;

    // The operation is still running — the handler did not wait for it.
    assert.equal(operationStarted.value, true, 'the operation should have been started');
    assert.equal(releaseOperation !== undefined, true, 'the operation should still be pending');
    assert.ok(elapsed < 1_000, `handler took ${elapsed}ms; it must return well inside HomeKit's 3s budget`);

    // HomeKit shows "Locking…" meanwhile: target is the new value, current is not there yet.
    assert.equal(readTargetState(harness), Characteristic.LockTargetState.SECURED);
    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.UNSECURED);

    releaseOperation!();
  });

  it('updates the current state once the operation completes', async () => {
    let releaseOperation: (() => void) | undefined;
    const harness = buildHarness({
      getState: async () => 'Unlocked',
      operate: () => new Promise<void>((resolve) => (releaseOperation = resolve)),
    });

    await writeTargetState(harness, Characteristic.LockTargetState.SECURED);
    releaseOperation!();
    // Let the background continuation settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(readCurrentState(harness), Characteristic.LockCurrentState.SECURED);
    assert.ok(harness.logs.some((entry) => entry.level === 'info' && /is now locked/.test(entry.message)));
  });

  it('reverts the target and logs an error when the command fails', async () => {
    const harness = buildHarness({
      getState: async () => 'Unlocked',
      operate: async () => {
        throw new Error('bridge offline');
      },
    });

    // Establish a known current state first.
    await harness.accessory.refresh();
    await writeTargetState(harness, Characteristic.LockTargetState.SECURED);
    await new Promise((resolve) => setImmediate(resolve));

    // The handler already returned, so failure surfaces by snapping back plus an error log.
    assert.equal(readTargetState(harness), Characteristic.LockTargetState.UNSECURED);

    const errors = harness.logs.filter((entry) => entry.level === 'error');
    assert.equal(errors.length >= 1, true, 'a user-initiated failure must always be logged as an error');
    assert.match(errors[0].message, /has NOT been locked/);
  });

  it('rejects a second command while one is still running', async () => {
    let releaseOperation: (() => void) | undefined;
    const harness = buildHarness({
      getState: async () => 'Unlocked',
      operate: () => new Promise<void>((resolve) => (releaseOperation = resolve)),
    });

    await writeTargetState(harness, Characteristic.LockTargetState.SECURED);

    assert.throws(
      () => writeTargetState(harness, Characteristic.LockTargetState.UNSECURED),
      HapStatusError,
      'overlapping taps should be rejected, not queued up',
    );

    releaseOperation!();
  });
});

describe('battery service', () => {
  it('is linked to the lock so it is not shown as a separate accessory', () => {
    const harness = buildHarness({ getState: async () => 'Locked', showBattery: true });
    assert.equal(harness.lockService.linked.length, 1, 'battery service should be linked to the lock service');
  });

  /**
   * A failing battery read used to leave the lock permanently "due", so it retried on every poll
   * cycle — roughly every 18s against a configured hour, doubling the load on
   * an already-struggling bridge.
   */
  it('backs off failed battery reads instead of retrying every poll', async () => {
    let attempts = 0;
    const harness = buildHarness({
      getState: async () => 'Locked',
      showBattery: true,
      batteryPollInterval: 3600,
      getBattery: async () => {
        attempts++;
        throw new Error('BridgeNotAttached');
      },
    });

    for (let i = 0; i < 6; i++) {
      await harness.accessory.refresh();
    }

    assert.equal(attempts, 1, `battery should be attempted once per interval, not once per poll (got ${attempts})`);
  });

  it('warns once about an unreadable battery, not on every attempt', async () => {
    let failing = true;
    const harness = buildHarness({
      getState: async () => 'Locked',
      showBattery: true,
      // Always due, so every refresh attempts a read.
      batteryPollInterval: 0,
      unresponsiveThreshold: 2,
      getBattery: async () => {
        if (failing) {
          throw new Error('BridgeNotAttached');
        }
        return 72;
      },
    });

    for (let i = 0; i < 10; i++) {
      await harness.accessory.refresh();
    }

    const warnings = harness.logs.filter((entry) => entry.level === 'warn');
    assert.equal(warnings.length, 1, `one warning per outage, not one per attempt (got ${warnings.length})`);
    assert.match(warnings[0].message, /Battery level unavailable/);

    // ...and recovery is reported, so the log doesn't imply it is still broken.
    failing = false;
    await harness.accessory.refresh();
    assert.ok(
      harness.logs.some((entry) => entry.level === 'info' && /battery level is readable again/i.test(entry.message)),
      'recovery should be logged',
    );
  });
});
