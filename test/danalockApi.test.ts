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
  backgroundJobTimeoutMs: 2_000,
  bridgeBusyBackoffMs: 5,
};

/** Captures log output so tests can assert on what an operator would actually see. */
function recordingLog(): ApiLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  return { lines, debug: push, info: push, warn: push, error: push };
}

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

  /**
   * Retrying a busy bridge used to turn one busy round into ~25s of occupation, amplifying the
   * contention it was reacting to. The caller backs off instead.
   */
  it('does NOT retry when the bridge reports itself busy', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();

    let polls = 0;
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, () => {
        polls++;
        return { id: 'job-1', status: 'Failed', result: { bridge_server_status_text: 'bridgebusy' } };
      })
      .persist();

    await assert.rejects(() => newClient().getState(LOCK_A), /busy/i);
    assert.equal(polls, 1, `a busy bridge must be asked exactly once, not retried (got ${polls})`);
  });
});

describe('diagnostics', () => {
  const succeedingBridge = (): void => {
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Succeeded', result: { state: 'Locked' } })
      .persist();
  };

  it('logs each operation with its bridge, outcome and duration', async () => {
    mockToken();
    succeedingBridge();

    const log = recordingLog();
    const client = new DanalockApiClient('user@example.com', 'secret', log, FAST);
    client.setBridgeForLock(LOCK_A, BRIDGE_1);

    await client.getState(LOCK_A);

    // Successes matter as much as failures: they are the baseline a bad bridge is judged against.
    const line = log.lines.find((l) => l.includes('afi.lock.get-state') && l.includes('ok'));
    assert.ok(line, `expected a per-operation line, got: ${JSON.stringify(log.lines)}`);
    assert.match(line!, new RegExp(`bridge ${BRIDGE_1}`), 'the line must name the bridge, not just the lock');
    assert.match(line!, /in \d+ms/, 'the line must record how long the operation took');
  });

  it('summarises per bridge, keeping bridges separate', async () => {
    mockToken();
    succeedingBridge();

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_2);

    await client.getState(LOCK_A);
    await client.getState(LOCK_B);
    await client.getState(LOCK_B);

    const summary = client.drainBridgeSummary();
    assert.equal(summary.length, 2, 'one line per bridge that saw traffic');

    const first = summary.find((l) => l.includes(BRIDGE_1))!;
    const second = summary.find((l) => l.includes(BRIDGE_2))!;
    assert.match(first, /1\/1 ok/);
    assert.match(second, /2\/2 ok/, 'counts must not be pooled across bridges');

    // Draining resets the window, so each summary covers only its own period.
    assert.deepEqual(client.drainBridgeSummary(), []);
  });

  it('records the failure reason in the summary', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Failed', result: { bridge_server_status_text: 'ConnectionLost' } })
      .persist();

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);

    await assert.rejects(() => client.getState(LOCK_A));

    const summary = client.drainBridgeSummary();
    assert.match(summary[0], /0\/1 ok/);
    assert.match(summary[0], /ConnectionLost/, 'the reason is what distinguishes an unstable link from a throttle');
  });

  it('never writes credentials or tokens to the log', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(500, 'upstream exploded').persist();

    const log = recordingLog();
    const client = new DanalockApiClient('user@example.com', 'hunter2', log, FAST);
    client.setBridgeForLock(LOCK_A, BRIDGE_1);

    await assert.rejects(() => client.getState(LOCK_A));

    const everything = log.lines.join('\n');
    assert.ok(!everything.includes('hunter2'), 'the password must never reach the log');
    assert.ok(!everything.includes('access-1'), 'the access token must never reach the log');
    assert.ok(!/authorization/i.test(everything), 'auth headers must never reach the log');
    // ...while still surfacing the server's own message, which is where a throttle would show up.
    assert.match(everything, /upstream exploded/);
  });

  it('gives up sooner on a background read than on a user command', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();
    // A job that never completes — the bridge has effectively hung.
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'InProgress' })
      .persist();

    const client = new DanalockApiClient('user@example.com', 'secret', silentLog, {
      jobPollIntervalMs: 5,
      backgroundJobTimeoutMs: 120,
      jobTimeoutMs: 600,
    });
    client.setBridgeForLock(LOCK_A, BRIDGE_1);

    // A hung background poll must not hold the bridge's queue for the full command timeout.
    const backgroundStart = Date.now();
    await assert.rejects(() => client.getState(LOCK_A), /timed out/);
    const background = Date.now() - backgroundStart;

    const commandStart = Date.now();
    await assert.rejects(() => client.operate(LOCK_A, 'lock'), /timed out/);
    const command = Date.now() - commandStart;

    assert.ok(background < 400, `background read waited ${background}ms; expected the shorter timeout`);
    assert.ok(command > background, `a user command (${command}ms) should be given more patience than a poll (${background}ms)`);
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

  /**
   * The ceiling that keeps a bridge usable by the Danalock app: one background operation per
   * bridge per interval, no matter which scheduler asked or how many locks sit behind it.
   */
  it('spaces background operations on a bridge by the configured gap', async () => {
    mockToken();
    const stamps: number[] = [];
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/execute', method: 'POST' })
      .reply(200, () => {
        stamps.push(Date.now());
        return { id: 'job-1' };
      })
      .persist();
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Succeeded', result: { state: 'Locked' } })
      .persist();

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_1);
    client.setMinOperationGap(120);

    // Two locks behind one bridge must share its budget, not double its load.
    await client.getState(LOCK_A);
    await client.getState(LOCK_B);
    await client.getState(LOCK_A);

    assert.equal(stamps.length, 3);
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i] - stamps[i - 1];
      assert.ok(gap >= 100, `operations ${i} and ${i + 1} were ${gap}ms apart; expected at least the configured gap`);
    }
  });

  /**
   * The cooldown is a *bridge* budget, not an account one. Bridges are independent hardware, so one
   * being busy must not hold up another.
   *
   * Guards a silent regression: keying the cooldown on anything coarser — the account, a global —
   * would halve throughput for anyone with more than one bridge while raising no error and logging
   * nothing. Without this test, the same-bridge spacing test above would still pass.
   */
  it('applies the cooldown per bridge, so a busy bridge does not hold up another', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Succeeded', result: { state: 'Locked' } })
      .persist();

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setBridgeForLock(LOCK_B, BRIDGE_2);
    client.setMinOperationGap(5_000);

    await client.getState(LOCK_A); // starts BRIDGE_1's cooldown

    const started = Date.now();
    await client.getState(LOCK_B); // different bridge — must not wait on BRIDGE_1
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1_000, `a read on a second bridge waited ${elapsed}ms behind the first bridge's cooldown`);
  });

  it('never makes a user command wait for the cooldown', async () => {
    mockToken();
    agent.get(BRIDGE_ORIGIN).intercept({ path: '/bridge/v1/execute', method: 'POST' }).reply(200, { id: 'job-1' }).persist();
    agent
      .get(BRIDGE_ORIGIN)
      .intercept({ path: '/bridge/v1/poll', method: 'POST' })
      .reply(200, { id: 'job-1', status: 'Succeeded', result: { state: 'Locked' } })
      .persist();

    const client = newClient();
    client.setBridgeForLock(LOCK_A, BRIDGE_1);
    client.setMinOperationGap(5_000);

    await client.getState(LOCK_A); // starts the cooldown

    const started = Date.now();
    await client.operate(LOCK_A, 'lock');
    const elapsed = Date.now() - started;

    // Someone is standing at the door; a throttle must not hold them up.
    assert.ok(elapsed < 1_000, `user command waited ${elapsed}ms behind the cooldown`);
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
