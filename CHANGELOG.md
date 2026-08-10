# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-10

Diagnostics and logging fixes, all found while investigating a real outage in which both
Danabridges lost their connection to the Danalock cloud. None of these caused the outage, but two
of them made it noisier and put avoidable extra load on the failing bridges.

### Fixed

- **Failed battery reads no longer retry every poll cycle.** Scheduling was based on the last
  *successful* read, so once a battery read started failing the lock looked perpetually due and was
  retried on every cycle — roughly every 18 seconds against a configured hour, and over a hundred
  consecutive times in one observed case. That doubled the request load on a bridge that was
  already struggling. Scheduling is now based on the last *attempt*, successful or not.
- **An unreadable battery is warned about once per outage, not once per attempt.** State reads
  already behaved this way; battery reads did not, producing hundreds of identical warnings.
  Recovery is now logged too.
- **Bridge failures report what actually went wrong.** Only two fields of the failure payload were
  consulted, so reasons carried elsewhere — `BridgeNotAttached` among them — were reported as
  "unknown error", discarding exactly the detail needed to tell an offline Danabridge from a lock
  out of Bluetooth range. Other known fields are now consulted, and an unrecognised payload is
  surfaced verbatim rather than swallowed.

## [0.1.0] - 2026-08-07

First public release.

### Added

- Exposes Danalock V3 locks in HomeKit as Lock Mechanisms, via the Danalock cloud API and a
  Danabridge. Locking, unlocking, and state reporting are supported.
- Battery level reported on the lock accessory itself (a linked Battery service), driving the
  standard HomeKit Low Battery warning rather than appearing as a separate tile.
- Automatic discovery of every lock on the account, one HomeKit accessory per lock. Accessory
  identity is derived from the lock's serial number, so renaming a lock in the Danalock app does
  not require re-pairing.
- Operations are serialised **per Danabridge**. A bridge handles one operation at a time, so locks
  behind different bridges run in parallel while locks sharing a bridge queue up. If a lock's
  bridge cannot be determined, the plugin warns and falls back to a single shared queue rather
  than risk overlapping requests.
- A lock that fails several consecutive state reads is reported as **No Response** instead of
  continuing to display a state that can no longer be verified — showing "Locked" for a door that
  may be open is a safety problem. Communication failure and unrecognised-state are kept distinct.
- Configurable poll interval, battery poll interval, low-battery threshold, unresponsive
  threshold, and an optional filter to include or exclude specific locks.

### Fixed

- **"No Response" flash after operating a lock from the Home app.** The `LockTargetState` write
  handler awaited the entire lock operation, but HomeKit allows a write handler only 9 seconds
  before it gives up with `OPERATION_TIMED_OUT` and marks the accessory unresponsive. A Danalock
  operation takes 5–7 seconds by itself, and longer when queued behind a poll, so the budget was
  routinely exceeded. The handler now returns immediately and reconciles state in the background.
  As a side effect the Home app now correctly shows "Locking…" / "Unlocking…" while the bolt moves.
- User-initiated lock and unlock commands take priority in the per-bridge queue, so a tap in the
  Home app waits only for the operation already in flight rather than the whole backlog of
  background polls.

### Known limitations

- Requires a Danabridge and an internet connection; the Danalock V3-BT is Bluetooth-only and the
  Danabridge has no local API.
- Each operation takes roughly 5–7 seconds (cloud → bridge → Bluetooth → lock). Changes made
  outside HomeKit are detected by polling, as the API offers no push notifications.
- Built on unofficial, undocumented API endpoints, which Danalock could change at any time.

[0.1.1]: https://github.com/mend1/homebridge-danalock/releases/tag/v0.1.1
[0.1.0]: https://github.com/mend1/homebridge-danalock/releases/tag/v0.1.0
