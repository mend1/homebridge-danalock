import { fetch } from 'undici';

import {
  CLIENT_ID,
  DEFAULTS,
  EXECUTE_URL,
  JOB_FAILED,
  JOB_SUCCEEDED,
  LOCKS_URL,
  OP_GET_BATTERY,
  OP_GET_STATE,
  OP_OPERATE,
  POLL_URL,
  TOKEN_URL,
  UNKNOWN_BRIDGE_KEY,
  USER_AGENT,
  pairedDevicesUrl,
} from './settings.js';

/** Minimal logger surface, satisfied by Homebridge's Logger and by test stubs. */
export interface ApiLogger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export interface DanalockLock {
  serial: string;
  name: string;
}

export type LockState = 'Locked' | 'Unlocked';
export type LockOperation = 'lock' | 'unlock';

/** Authentication failed and cannot be recovered without user intervention. */
export class DanalockAuthError extends Error {}

/** A transport or HTTP-level failure. */
export class DanalockApiError extends Error {}

/** A bridge job failed, timed out, or returned an unusable result. */
export class DanalockJobError extends Error {
  constructor(message: string, readonly busy = false) {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface JobPollResponse {
  status?: string;
  result?: Record<string, unknown>;
}

/** Tunable timings; overridable so tests don't have to wait out real-world delays. */
export interface ApiTimings {
  requestTimeoutMs: number;
  jobPollIntervalMs: number;
  jobTimeoutMs: number;
  bridgeBusyRetries: number;
  bridgeBusyBackoffMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detects the bridge's "busy" condition. The bridge handles one operation at a time; if something
 * else (the Danalock app, another Homebridge instance) is mid-operation, the job fails this way.
 * The exact spelling varies, so match loosely on a normalised string.
 */
const isBusyMessage = (text: string): boolean => {
  const normalised = text.toLowerCase().replace(/[\s_-]/g, '');
  return normalised.includes('bridgebusy') || normalised.includes('busy');
};

/**
 * Client for the (unofficial) Danalock cloud API.
 *
 * Concurrency: the one-operation-at-a-time limit belongs to the *Danabridge*, not the account, so
 * operations are serialised per bridge. Locks behind different bridges run in parallel; locks
 * sharing a bridge queue up behind each other. Callers register the mapping via
 * {@link setBridgeForLock}; anything unmapped falls back to a single shared queue, which is slower
 * but never risks hammering a bridge.
 */
export class DanalockApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;

  /** lock serial -> bridge serial (queue key). */
  private readonly bridgeByLock = new Map<string, string>();

  /** queue key -> tail of the promise chain for that bridge. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Guards against concurrent token refreshes. */
  private authInFlight: Promise<void> | null = null;

  private readonly timings: ApiTimings;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: ApiLogger,
    timings: Partial<ApiTimings> = {},
  ) {
    this.timings = {
      requestTimeoutMs: DEFAULTS.requestTimeoutMs,
      jobPollIntervalMs: DEFAULTS.jobPollIntervalMs,
      jobTimeoutMs: DEFAULTS.jobTimeoutMs,
      bridgeBusyRetries: DEFAULTS.bridgeBusyRetries,
      bridgeBusyBackoffMs: DEFAULTS.bridgeBusyBackoffMs,
      ...timings,
    };
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /** Authenticates with username/password, replacing any existing tokens. */
  async authenticate(): Promise<void> {
    this.log.debug('Authenticating with the Danalock API.');

    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.username,
      password: this.password,
      client_id: CLIENT_ID,
    });

    const token = await this.tokenRequest(body, 'password grant');
    this.applyToken(token);
    this.log.debug('Authentication succeeded.');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new DanalockAuthError('No refresh token available.');
    }

    this.log.debug('Refreshing the Danalock access token.');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: CLIENT_ID,
    });

    const token = await this.tokenRequest(body, 'refresh grant');
    this.applyToken(token);
  }

  private async tokenRequest(body: URLSearchParams, description: string): Promise<TokenResponse> {
    let response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timings.requestTimeoutMs),
      });
    } catch (error) {
      // A network failure is not an auth failure — surfacing it as one would wrongly tell the user
      // their credentials are bad.
      throw new DanalockApiError(`Could not reach the Danalock authentication service (${description}): ${errorText(error)}`);
    }

    if (!response.ok) {
      throw new DanalockAuthError(
        `Danalock authentication failed (${description}): HTTP ${response.status}. Check the account email and password.`,
      );
    }

    const parsed = (await response.json()) as Partial<TokenResponse>;
    if (!parsed?.access_token || !parsed?.refresh_token || typeof parsed?.expires_in !== 'number') {
      throw new DanalockAuthError(`Danalock returned an unexpected authentication response (${description}).`);
    }

    return parsed as TokenResponse;
  }

  private applyToken(token: TokenResponse): void {
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    // Renew a minute early so a request never races the expiry.
    this.tokenExpiresAt = Date.now() + token.expires_in * 1000 - 60_000;
  }

  /** Ensures a usable access token, refreshing or re-authenticating as needed. */
  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return;
    }

    // Collapse concurrent callers onto one refresh — with several locks polling in parallel this
    // would otherwise fire a burst of identical token requests.
    if (this.authInFlight) {
      return this.authInFlight;
    }

    this.authInFlight = (async () => {
      try {
        if (this.refreshToken) {
          try {
            await this.refreshAccessToken();
            return;
          } catch (error) {
            this.log.debug(`Token refresh failed (${errorText(error)}); falling back to password authentication.`);
            this.accessToken = null;
            this.refreshToken = null;
          }
        }
        await this.authenticate();
      } finally {
        this.authInFlight = null;
      }
    })();

    return this.authInFlight;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async request<T>(method: 'GET' | 'POST', url: string, jsonBody?: unknown): Promise<T> {
    await this.ensureToken();

    const send = async (): Promise<{ ok: boolean; status: number; body: unknown }> => {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'user-agent': USER_AGENT,
            accept: 'application/json',
            ...(jsonBody === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
          signal: AbortSignal.timeout(this.timings.requestTimeoutMs),
        });
      } catch (error) {
        throw new DanalockApiError(`Request to ${redactUrl(url)} failed: ${errorText(error)}`);
      }

      let body: unknown = null;
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { ok: response.ok, status: response.status, body };
    };

    let result = await send();

    // A 401 mid-session means the token died early; re-authenticate once and retry.
    if (result.status === 401) {
      this.log.debug('Received HTTP 401; re-authenticating and retrying once.');
      this.accessToken = null;
      this.tokenExpiresAt = 0;
      await this.ensureToken();
      result = await send();
    }

    if (!result.ok) {
      if (result.status === 401) {
        throw new DanalockAuthError('Danalock rejected the credentials (HTTP 401).');
      }
      throw new DanalockApiError(`${method} ${redactUrl(url)} returned HTTP ${result.status}.`);
    }

    return result.body as T;
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  /** Lists every lock on the account. */
  async getLocks(): Promise<DanalockLock[]> {
    const body = await this.request<unknown>('GET', LOCKS_URL);
    if (!Array.isArray(body)) {
      throw new DanalockApiError('Danalock returned an unexpected response for the lock list.');
    }

    const locks: DanalockLock[] = [];
    for (const entry of body) {
      const record = entry as { name?: unknown; afi?: { serial_number?: unknown } };
      const serial = record?.afi?.serial_number;
      const name = record?.name;
      if (typeof serial === 'string' && serial && typeof name === 'string' && name) {
        locks.push({ serial, name });
      } else {
        this.log.debug(`Skipping a lock entry without a usable serial/name: ${JSON.stringify(entry)}`);
      }
    }
    return locks;
  }

  /**
   * Resolves the Danabridge a lock is paired with. Used purely to group locks onto the correct
   * serialisation queue — command routing itself is handled cloud-side from the lock serial.
   */
  async getPairedBridge(lockSerial: string): Promise<string | null> {
    const body = await this.request<unknown>('GET', pairedDevicesUrl(lockSerial));
    if (!Array.isArray(body)) {
      return null;
    }

    for (const entry of body) {
      const device = (entry as { device?: { serial_number?: unknown; device_type?: unknown } })?.device;
      const type = device?.device_type;
      const serial = device?.serial_number;
      if (typeof type === 'string' && type.toLowerCase().startsWith('danabridge') && typeof serial === 'string' && serial) {
        return serial;
      }
    }
    return null;
  }

  /** Registers which bridge a lock sits behind, so its operations queue on the right key. */
  setBridgeForLock(lockSerial: string, bridgeSerial: string | null): void {
    if (bridgeSerial) {
      this.bridgeByLock.set(lockSerial, bridgeSerial);
    } else {
      this.bridgeByLock.delete(lockSerial);
    }
  }

  private queueKey(lockSerial: string): string {
    return this.bridgeByLock.get(lockSerial) ?? UNKNOWN_BRIDGE_KEY;
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  /** Reads the lock's current state. Throws on failure so callers can track failure streaks. */
  async getState(lockSerial: string): Promise<LockState | null> {
    const result = await this.run(lockSerial, OP_GET_STATE);
    const state = result['state'];
    if (state === 'Locked' || state === 'Unlocked') {
      return state;
    }
    // The bridge answered, but not with a state we recognise: distinct from "unreachable".
    this.log.debug(`Lock ${lockSerial} reported an unrecognised state: ${JSON.stringify(state)}`);
    return null;
  }

  /** Reads the battery percentage. Throws on failure so callers can track failure streaks. */
  async getBattery(lockSerial: string): Promise<number | null> {
    const result = await this.run(lockSerial, OP_GET_BATTERY);
    const level = result['battery_level'];
    if (typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 100) {
      return Math.round(level);
    }
    this.log.debug(`Lock ${lockSerial} reported an unusable battery level: ${JSON.stringify(level)}`);
    return null;
  }

  /** Locks or unlocks. Throws if the operation did not complete. */
  async operate(lockSerial: string, operation: LockOperation): Promise<void> {
    await this.run(lockSerial, OP_OPERATE, [operation]);
  }

  /**
   * Queues an operation on the lock's bridge, then runs the execute → poll cycle, retrying if the
   * bridge reports itself busy.
   */
  private run(lockSerial: string, operation: string, args?: string[]): Promise<Record<string, unknown>> {
    return this.enqueue(this.queueKey(lockSerial), async () => {
      let lastError: DanalockJobError | undefined;

      for (let attempt = 1; attempt <= this.timings.bridgeBusyRetries; attempt++) {
        try {
          return await this.executeAndPoll(lockSerial, operation, args);
        } catch (error) {
          if (error instanceof DanalockJobError && error.busy && attempt < this.timings.bridgeBusyRetries) {
            const delay = this.timings.bridgeBusyBackoffMs * attempt;
            this.log.debug(`Bridge busy for ${lockSerial} (${operation}); retrying in ${delay}ms (attempt ${attempt}).`);
            lastError = error;
            await sleep(delay);
            continue;
          }
          throw error;
        }
      }

      throw lastError ?? new DanalockJobError(`Operation ${operation} failed for ${lockSerial}.`);
    });
  }

  /**
   * Serialises tasks per queue key. Each key keeps its own promise chain, so separate bridges
   * proceed independently while a shared bridge runs strictly one operation at a time.
   */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    // Run after the previous task regardless of whether it succeeded — one failure must not
    // wedge the queue for that bridge.
    const run = previous.then(task, task);
    // Store a non-rejecting tail so an unhandled rejection can't escape the chain.
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** One execute → poll cycle against the bridge. */
  private async executeAndPoll(
    lockSerial: string,
    operation: string,
    args?: string[],
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { device: lockSerial, operation };
    if (args?.length) {
      payload['arguments'] = args;
    }

    const execution = await this.request<{ id?: unknown }>('POST', EXECUTE_URL, payload);
    const jobId = execution?.id;
    if (typeof jobId !== 'string' || !jobId) {
      throw new DanalockJobError(`The bridge did not return a job id for ${operation}.`);
    }

    this.log.debug(`Job ${jobId}: ${operation} on ${lockSerial}.`);

    const deadline = Date.now() + this.timings.jobTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.timings.jobPollIntervalMs);

      const poll = await this.request<JobPollResponse>('POST', POLL_URL, { id: jobId });
      const status = poll?.status;

      if (status === JOB_SUCCEEDED) {
        return poll.result ?? {};
      }

      if (status === JOB_FAILED) {
        const detail = String(poll.result?.['bridge_server_status_text'] ?? poll.result?.['afi_status_text'] ?? 'unknown error');
        throw new DanalockJobError(`${operation} failed: ${detail}`, isBusyMessage(detail));
      }

      // Created / InProgress / anything else transient — keep polling until the deadline.
    }

    throw new DanalockJobError(
      `${operation} timed out after ${Math.round(this.timings.jobTimeoutMs / 1000)}s. ` +
        'The Danabridge may be offline or out of Bluetooth range of the lock.',
    );
  }
}

/** Extracts a readable message without leaking anything sensitive. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Strips any serial-looking path segment so debug logs stay shareable. */
function redactUrl(url: string): string {
  return url.replace(/[0-9a-f]{2}(:[0-9a-f]{2}){3,}/gi, '<serial>');
}
