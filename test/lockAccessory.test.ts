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
  displayName = 'Front Door';

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
  unresponsiveThreshold?: number;
  showBattery?: boolean;
}): Harness {
  const logs: { level: string; message: string }[] = [];
  const record = (level: string) => (message: string) => logs.push({ level, message });

  const api2 = {
    getState: options.getState,
    getBattery: async () => null,
    operate: async () => undefined,
  };

  const platform = {
    Service,
    Characteristic,
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    api: { hap: { HapStatusError, HAPStatus } },
    api2,
    options: {
      pollInterval: 10,
      batteryPollInterval: 3600,
      showBattery: options.showBattery ?? false,
      lowBatteryThreshold: 20,
      unresponsiveThreshold: options.unresponsiveThreshold ?? 3,
    },
    scheduleConfirmation: () => undefined,
  } as unknown as DanalockPlatform;

  const fakeAccessory = new FakeAccessory({ serial: '11:11:11:11:11:11', name: 'Front Door' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accessory = new DanalockLockAccessory(platform, fakeAccessory as any);

  return { accessory, lockService: fakeAccessory.getService(Service.LockMechanism)!, logs, api2 };
}

const readCurrentState = (harness: Harness): unknown =>
  harness.lockService.getCharacteristic(Characteristic.LockCurrentState).getHandler!();

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

describe('battery service', () => {
  it('is linked to the lock so it is not shown as a separate accessory', () => {
    const harness = buildHarness({ getState: async () => 'Locked', showBattery: true });
    assert.equal(harness.lockService.linked.length, 1, 'battery service should be linked to the lock service');
  });
});
