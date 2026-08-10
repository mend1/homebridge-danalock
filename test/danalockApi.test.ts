import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MockAgent, setGlobalDispatcher } from 'undici';

import { DanalockApiClient, DanalockAuthError, type ApiLogger } from '../src/danalockApi.js';

const API_ORIGIN = 'https://api.danalock.com';
const BRIDGE_ORIGIN = 'https://bridge.danalockservices.com';

const LOCK_A = '11:11:11:11:11:11';
const LOCK_B = '22:22:22:22:22:22';
const BRIDGE_1 = 'aa:aa:aa:aa:aa:aa';
const BRIDGE_2 = 'bb:bb:bb:bb:bb:bb';

const silentLog: ApiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Fast timings so tests don't sit through real-world bridge delays. */
const FAST = {
  jobPollIntervalMs: 5,
  jobTimeoutMs: 2_000,
  bridgeBusyBackoffMs: 5,
};

let agent: MockAgent;
/** Ordered log of requests, used to assert queueing behaviour. */
let events: string[];

const newClient = (timings = FAST) => new DanalockApiClient('user@example.com', 'secret', silentLog, timings);

/** Every test needs a token before anything else will work. */
function mockToken(times = 1): void {
  agent
    .get(API_ORIGIN)
    .intercept({ path: '/oauth2/token', method: 'POST' })
    .reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
    .times(times);
}

const bodyIncludes = (fragment: string) => (body: string | null) => (body ?? '').includes(fragment);

beforeEach(() => {
  events = [];
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

describe('authentication', () => {
  it('obtains a token and lists locks', async () => {
    mockToken();
    agent
      .get(API_ORIGIN)
      .intercept({ path: '/locks/v1', method: 'GET' })
      .reply(200, [
        { name: 'Front Door', afi: { serial_number: LOCK_A, device_type: 'danalockv3' } },
        { name: 'Back Door', afi: { serial_number: LOCK_B, device_type: 'danalockv3' } },
        { name: 'Broken entry with no serial' },
      ]);

    const locks = await newClient().getLocks();

    assert.deepEqual(locks, [
      { serial: LOCK_A, name: 'Front Door' },
      { serial: LOCK_B, name: 'Back Door' },
    ]);
  });

  it('reports bad credentials as an auth error, not a generic failure', async () => {
    agent.get(API_ORIGIN).intercept({ path: '/oauth2/token', method: 'POST' }).reply(400, { error: 'invalid_grant' });

    await assert.rejects(() => newClient().getLocks(), DanalockAuthError);
  });

  it('resolves the paired Danabridge for a lock', async () => {
    mockToken();
    agent
      .get(API_ORIGIN)
      .intercept({ path: `/devices/v1/${encodeURIComponent(LOCK_A)}/paired_devices`, method: 'GET' })
      .reply(200, [
        { type: '2', device: { serial_number: 'cc:cc:cc:cc:cc:cc', name: 'Phone', device_type: 'iphone' } },
        { type: '1', device: { serial_number: BRIDGE_1, name: 'Danabridge', device_type: 'danabridgev3' } },
      ]);

    assert.equal(await newClient().getPairedBridge(LOCK_A), BRIDGE_1);
  });
});

describe('execute/poll state machine', () => {
  it('polls until the job succeeds and returns the state', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' });

    let polls = 0;
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, () => {
        polls++;
        // Mirror the real bridge: a couple of in-progress replies before the result lands.
        return polls < 3 ? { id: 'job-1', status: 'InProgress' } : { id: 'job-1', status: 'Succeeded', result: { state: 'Locked' } };
      })
      .times(3);

    assert.equal(await newClient().getState(LOCK_A), 'Locked');
    assert.equal(polls, 3);
  });

  it('returns null when the bridge answers with an unrecognised state', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' });
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Succeeded', result: { state: 'Wobbly' } });

    // Distinct from "unreachable": the bridge replied, so this is not a comms failure.
    assert.equal(await newClient().getState(LOCK_A), null);
  });

  it('throws when the job fails so callers can count the failure', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' });
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Failed', result: { bridge_server_status_text: 'deviceoffline' } });

    await assert.rejects(() => newClient().getState(LOCK_A), /deviceoffline/);
  });

  it('reports the real failure reason rather than "unknown error"', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' });
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, {
        id: 'job-1',
        status: 'Failed',
        // The reason is not in the field we look at first, and the usual fields say "ok".
        result: { afi_status_text: 'ok', dmi_status_text: 'BridgeNotAttached' },
      });

    // Telling a dead Danabridge from a lock out of range depends on this text surviving.
    await assert.rejects(() => newClient().getState(LOCK_A), /BridgeNotAttached/);
  });

  it('surfaces the raw payload when no known field carries the reason', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' });
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Failed', result: { some_future_field: 'GatewayTimeout' } });

    await assert.rejects(() => newClient().getState(LOCK_A), /GatewayTimeout/);
  });

  it('retries when the bridge reports itself busy, then succeeds', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).times(2);

    let attempt = 0;
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, () => {
        attempt++;
        return attempt === 1
          ? { id: 'job-1', status: 'Failed', result: { bridge_server_status_text: 'bridgebusy' } }
          : { id: 'job-1', status: 'Succeeded', result: { state: 'Unlocked' } };
      })
      .times(2);

    assert.equal(await newClient().getState(LOCK_A), 'Unlocked');
    assert.equal(attempt, 2, 'should have retried once after the busy response');
  });
});

describe('per-bridge serialisation', () => {
  /**
   * Records request order. Execute replies are delayed so that, if two operations really do run
   * concurrently, both execute calls land before either job is polled.
   */
  function mockTwoLocks(): void {
    mockToken();

    for (const [lock, label] of [
      [LOCK_A, 'A'],
      [LOCK_B, 'B'],
    ] as const) {
      agent
        .get(BRIDGE_ORIGIN)
        .intercept({ path: '/bridge/v1/execute', method: 'POST', body: bodyIncludes(lock) })
        .reply(200, () => {
          events.push(`execute:${label}`);
          return { id: `job-${label}` };
        })
        .delay(20);

      agent
        .get(BRIDGE_ORIGIN)
        .intercept({ path: '/bridge/v1/poll', method: 'POST', body: bodyIncludes(`job-${label}`) })
        .reply(200, () => {
          events.push(`poll:${label}`);
          return { id: `job-${label}`, status: 'Succeeded', result: { state: 'Locked' } };
        })
        .persist();
    }
  }

  it('runs locks on DIFFERENT bridges in parallel', async () => {
    mockTwoLocks();
    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_2);

    await Promise.all([client.getState(LOCK_A), client.getState(LOCK_B)]);

    // Both executes are issued before either job is polled — they overlapped.
    assert.deepEqual(events.slice(0, 2).sort(), ['execute:A', 'execute:B']);
  });

  it('serialises locks sharing ONE bridge, so the bridge never sees concurrent operations', async () => {
    mockTwoLocks();
    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_1);

    await Promise.all([client.getState(LOCK_A), client.getState(LOCK_B)]);

    // The first lock must fully finish (execute + poll) before the second starts.
    assert.deepEqual(events, ['execute:A', 'poll:A', 'execute:B', 'poll:B']);
  });

  it('falls back to a single shared queue when the bridge is unknown', async () => {
    mockTwoLocks();
    const client = newClient();
    // No setBridgeForLock calls — e.g. paired_devices failed at discovery.

    await Promise.all([client.getState(LOCK_A), client.getState(LOCK_B)]);

    // Conservative: serialise rather than risk hammering a bridge we cannot identify.
    assert.deepEqual(events, ['execute:A', 'poll:A', 'execute:B', 'poll:B']);
  });

  it('lets a user command jump ahead of queued background polls', async () => {
    mockToken();

    // One bridge, three locks' worth of traffic. LOCK_A's read occupies the bridge first; a poll
    // for LOCK_B is queued behind it, then a user operation arrives.
    for (const [lock, label] of [
      [LOCK_A, 'A'],
      [LOCK_B, 'B'],
    ] as const) {
      agent
        .get(BRIDGE_ORIGIN)
        .intercept({ path: '/bridge/v1/execute', method: 'POST', body: bodyIncludes(lock) })
        .reply(200, (options) => {
          events.push(`execute:${label}`);
          // Record which operation ran, so ordering can be asserted by intent, not just by device.
          const payload = JSON.parse(String(options.body)) as { operation: string };
          events.push(`op:${payload.operation}`);
          return { id: `job-${label}` };
        })
        .delay(20)
        .persist();

      agent
        .get(BRIDGE_ORIGIN)
        .intercept({ path: '/bridge/v1/poll', method: 'POST', body: bodyIncludes(`job-${label}`) })
        .reply(200, { id: `job-${label}`, status: 'Succeeded', result: { state: 'Locked' } })
        .persist();
    }

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_1);

    const inFlight = client.getState(LOCK_A); // starts immediately, occupies the bridge
    const queuedPoll = client.getState(LOCK_B); // queued behind it
    const userCommand = client.operate(LOCK_B, 'lock'); // queued, but priority

    await Promise.all([inFlight, queuedPoll, userCommand]);

    // A is already running and cannot be pre-empted, but the user's command must overtake the
    // background poll that was queued ahead of it.
    const executes = events.filter((event) => event.startsWith('execute:'));
    assert.equal(executes.length, 3);
    assert.equal(executes[0], 'execute:A', 'the in-flight read runs first; it cannot be cancelled');
    assert.deepEqual(executes.slice(1), ['execute:B', 'execute:B']);

    // Prove ordering by intent: the user's command overtakes the poll that was queued before it.
    const operations = events.filter((event) => event.startsWith('op:'));
    assert.deepEqual(operations, [
      'op:afi.lock.get-state', // LOCK_A — already in flight, cannot be pre-empted
      'op:afi.lock.operate', // LOCK_B — user command, jumped ahead
      'op:afi.lock.get-state', // LOCK_B — background poll, ran last
    ]);
  });

  it('does not wedge a bridge queue when an operation fails', async () => {
    mockToken();

    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/execute', method: 'POST', body: bodyIncludes(LOCK_A) })
      .reply(500, 'boom');

    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/execute', method: 'POST', body: bodyIncludes(LOCK_B) })
      .reply(200, { id: 'job-B' });

    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-B', status: 'Succeeded', result: { state: 'Locked' } });

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_1);

    const [first, second] = await Promise.allSettled([client.getState(LOCK_A), client.getState(LOCK_B)]);

    assert.equal(first.status, 'rejected');
    // The queue must keep running after a failure, otherwise one bad poll kills the bridge forever.
    assert.equal(second.status, 'fulfilled');
  });
});
