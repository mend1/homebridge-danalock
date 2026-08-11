/**
 * Platform name registered with Homebridge. Must match `pluginAlias` in config.schema.json.
 */
export const PLATFORM_NAME = 'Danalock';

/**
 * Plugin name — must match the `name` field in package.json.
 */
export const PLUGIN_NAME = 'homebridge-danalock';

/** Danalock account/web API. */
export const API_BASE_URL = 'https://api.danalock.com';

/** Danalock bridge service — dispatches operations to the Danabridge paired with a lock. */
export const BRIDGE_BASE_URL = 'https://bridge.danalockservices.com';

export const TOKEN_URL = `${API_BASE_URL}/oauth2/token`;
export const LOCKS_URL = `${API_BASE_URL}/locks/v1`;
export const EXECUTE_URL = `${BRIDGE_BASE_URL}/bridge/v1/execute`;
export const POLL_URL = `${BRIDGE_BASE_URL}/bridge/v1/poll`;

export const pairedDevicesUrl = (lockSerial: string): string =>
  `${API_BASE_URL}/devices/v1/${encodeURIComponent(lockSerial)}/paired_devices`;

/** OAuth2 client id used by the Danalock web UI. There is no client secret. */
export const CLIENT_ID = 'danalock-web';

/**
 * The API rejects requests carrying a default/absent user agent, so send a browser-like one.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Bridge operations. */
export const OP_GET_STATE = 'afi.lock.get-state';
export const OP_OPERATE = 'afi.lock.operate';
export const OP_GET_BATTERY = 'afi.power-source.get-information2';

/** Job statuses returned by /bridge/v1/poll. */
export const JOB_SUCCEEDED = 'Succeeded';
export const JOB_FAILED = 'Failed';

/** Queue key used when a lock's Danabridge cannot be determined. */
export const UNKNOWN_BRIDGE_KEY = '__unknown_bridge__';

/** Timing defaults (seconds unless noted). */
export const DEFAULTS = {
  pollInterval: 10,
  minPollInterval: 5,
  batteryPollInterval: 3600,
  minBatteryPollInterval: 300,
  lowBatteryThreshold: 20,
  unresponsiveThreshold: 3,
  /** HTTP request timeout (ms). */
  requestTimeoutMs: 30_000,
  /** How often to poll a job for completion (ms). */
  jobPollIntervalMs: 1_000,
  /** Give up on a user-initiated bridge job after this long (ms). Operations normally take 5-7s. */
  jobTimeoutMs: 60_000,
  /**
   * Give up sooner on background reads (ms). A poll that has not landed by now is not going to,
   * and waiting the full minute holds the bridge's queue for several poll intervals.
   */
  backgroundJobTimeoutMs: 25_000,
  /** Attempts when the bridge reports it is busy. */
  bridgeBusyRetries: 3,
  /** Base backoff between busy retries (ms); multiplied by attempt number. */
  bridgeBusyBackoffMs: 2_000,
  /** Warn that a battery reading is stale after this long without a successful read (ms). */
  staleBatteryWarnMs: 24 * 60 * 60 * 1_000,
  /** Consecutive failed state reads before scheduled polling stops for a lock. */
  breakerThreshold: 5,
  /** First probe delay once the breaker opens (ms); doubles per failed probe. */
  probeBaseMs: 60_000,
  /** Ceiling on the probe interval (ms), so recovery is still noticed within half an hour. */
  probeMaxMs: 30 * 60_000,
  /** How often to emit the per-bridge summary (ms). */
  summaryIntervalMs: 5 * 60_000,
} as const;
