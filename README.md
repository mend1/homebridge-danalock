# homebridge-danalock

[![npm](https://img.shields.io/npm/v/homebridge-danalock.svg)](https://www.npmjs.com/package/homebridge-danalock)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Homebridge](https://homebridge.io) plugin that exposes **Danalock V3** smart locks in Apple
HomeKit, so you can lock and unlock them from the Home app, Siri, and automations.

Each lock appears as a HomeKit **Lock Mechanism**, with its **battery level** reported as part of
the same accessory.

## Status

Actively used and working, but only tested on Danalock V3-BT. Other setups — multiple locks behind
a single bridge, or the Z-Wave/Zigbee Danalock variants — should work by design but have not been
exercised. Bug reports welcome.

## Requirements

> [!IMPORTANT]
> **A [Danabridge](https://danalock.com/products/danabridge-v3) is required.**
> The Danalock V3-BT is a Bluetooth-only device with no IP connectivity of its own. The Danabridge
> is what puts it on the network. There is no local Danabridge API — see
> [How it works](#how-it-works) below.

- A Danalock V3 smart lock
- A Danabridge V3, paired with that lock and connected to Wi-Fi
- A Danalock account (the same credentials you use in the Danalock app)
- Homebridge v1.8 or later, Node.js 18 or later

Multiple locks and multiple Danabridges are fully supported, in any combination — one bridge per
lock, several locks behind one bridge, or a mix.

## Installation

Search for **Danalock** in the Homebridge UI's plugin tab and click Install, or from the command
line:

```bash
sudo npm install -g homebridge-danalock
sudo hb-service restart
```

Then configure it — either through the Homebridge UI, which renders a settings form from the
bundled schema, or by adding a platform block to `/var/lib/homebridge/config.json` as shown under
[Configuration](#configuration).

Check it came up with `sudo hb-service logs`; you should see `Loaded plugin: homebridge-danalock`,
then `Added "<your lock name>"` for each lock.

Node.js must satisfy the `engines` range (18 or newer). Check with `node -v`; if the server is
older, `sudo hb-service update-node` will update it.

## Configuration

Configure through the Homebridge UI, or add a platform block to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Danalock",
      "name": "Danalock",
      "username": "you@example.com",
      "password": "your-danalock-password",
      "pollInterval": 10,
      "showBattery": true
    }
  ]
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `username` | string | — | **Required.** Your Danalock account email. |
| `password` | string | — | **Required.** Your Danalock account password. Never written to the log. |
| `pollInterval` | number | `10` | Seconds between state-refresh rounds, and also the Danabridge's budget: at most one background operation per bridge per interval, shared by every lock behind that bridge. Controls how quickly changes made *outside* HomeKit are noticed. Minimum 10. Locking and unlocking is never delayed by it. |
| `batteryPollInterval` | number | `3600` | Seconds between battery reads. Minimum 300. |
| `showBattery` | boolean | `true` | Report the battery level on the lock accessory. |
| `lowBatteryThreshold` | number | `20` | Battery percentage at or below which HomeKit shows a Low Battery warning. |
| `unresponsiveThreshold` | number | `3` | Consecutive failed state reads before the lock shows as **No Response**. |
| `locks` | array | all | Optional filter. Include or exclude specific locks by name or serial. |

### Filtering which locks appear

Leave `locks` unset to expose every lock on the account. To hide one:

```json
"locks": [{ "identifier": "Garage", "exclude": true }]
```

If any entry is listed *without* `exclude`, only the listed locks are exposed.

## Lock naming

**No naming convention is required.** Name your locks whatever you like in the Danalock app —
spaces, hyphens, and accented characters are all fine.

This is worth stating explicitly, because the widely-referenced community Node-RED flow *does*
require alphanumeric-and-underscore names. That restriction exists only because it puts the lock
name into a URL path. This plugin never does: every API call is keyed on the lock's serial number
(`afi.serial_number`), and the name is used only for the HomeKit display name and the optional
`locks` filter.

**Renaming a lock is safe.** A lock's HomeKit identity is derived from its serial, not its name, so
renaming it in the Danalock app will not create a duplicate accessory or require re-pairing —
existing automations, scenes, and room assignments all survive. The name shown in Homebridge
updates on the next restart. If you renamed the accessory in the Home app, *your* name wins and
stays.

Two suggestions, neither of them requirements:

- **Give each lock a distinct name.** Locks sharing a name still work correctly — the serial keeps
  them apart internally — but Siri has no way to tell "unlock the front door" from another lock
  with the same name.
- **Prefer plain letters, numbers, and spaces.** HomeKit warns about names that don't begin and end
  with an alphanumeric character, and Siri handles simple names more reliably.

The `locks` filter matches case-insensitively against **either** the name or the serial number. If
you rename locks often, filter on the serial — it never changes.

## How it works

The V3-BT speaks only Bluetooth, and the Danabridge is **cloud-only by design** — it has no local
API, and stops working entirely without internet access. So every command travels:

```
Homebridge → Danalock cloud → your Danabridge → Bluetooth → the lock
```

The plugin authenticates against the Danalock cloud, discovers your locks, and issues operations
through the bridge service, checking each submitted job until it completes.

### Concurrency

A Danabridge processes **one operation at a time**; overlapping requests fail with a "bridge busy"
error. At startup the plugin works out which Danabridge each lock is paired with, and serialises
operations **per bridge**:

- Locks behind **different** bridges are polled and operated **in parallel**.
- Locks sharing **one** bridge queue up behind each other automatically.
- The plugin uses at most **one background operation per bridge per `pollInterval`**, leaving the
  rest of the bridge's time free for the Danalock app. Locking and unlocking bypasses this
  entirely.
- If a lock fails five state reads in a row, scheduled polling for it **pauses** and only
  occasional probes go out, backing off to at most 30 minutes. Any success resumes it — the pause
  never prevents you operating the door.

If a lock's bridge can't be determined, the plugin logs a warning and falls back to serialising
that lock with everything else — slower, but it never hammers a bridge.

### Diagnosing a troublesome bridge

Run Homebridge in debug mode — `sudo hb-service restart -D`, or Homebridge Debug Mode in the UI —
and the plugin logs a line for every bridge operation, plus a summary for each bridge every five
minutes:

```
[bridge aa:bb:cc:dd:ee:ff] afi.lock.get-state on 11:22:33:44:55:66: ok in 5820ms after 6 poll(s)
[bridge aa:bb:cc:dd:ee:ff] 18/20 ok, 2 failed (ConnectionLost×2); duration min/med/max 4980/5820/9100ms
```

Successes are included on purpose: a healthy bridge's timings are the baseline that makes a
troublesome one legible. With more than one bridge, comparing their summaries side by side over the
same window is usually enough to identify which is at fault.

**Two different things are called "polling" here**, and it helps to keep them apart:

- **`pollInterval`** is how often the plugin re-reads a lock's state — one scheduled refresh per
  interval.
- **`after 6 poll(s)`** in the logs counts something else: having submitted a single operation, how
  many times the plugin asked the cloud whether that job had finished. These are checks against
  Danalock's cloud, not extra work for the Danabridge.

The relationship between the two numbers is diagnostic. A failure `after 1 poll` means the cloud
rejected the job almost immediately — typically the Danabridge is not connected to it. A timeout
`after 25 poll(s)` means the opposite: the cloud accepted the job and the bridge never answered,
which points at the Bluetooth link between bridge and lock rather than the bridge's network
connection.

`Pausing scheduled polling for "<lock>"` means that lock failed five state reads in a row, so the
plugin has backed off to occasional probes. It resumes on the first success, and locking and
unlocking still work while polling is paused.

## Known limitations

These are properties of the Danalock platform, not of this plugin:

- **It depends on the cloud.** Homebridge and the Danabridge both need internet access. If
  Danalock's service is down, the lock cannot be operated. There is no local alternative.
- **Operations take about 5–7 seconds.** That is the cloud → bridge → Bluetooth round-trip.
  Locking or unlocking from HomeKit updates the state as soon as the command succeeds, so it feels
  responsive; the poll interval only affects how quickly changes made *elsewhere* (a physical key,
  the Danalock app, auto-lock) show up. Sub-second polling is not possible.
- **There is no push/webhook.** Polling is the only way to detect external changes.
- **The API is unofficial.** It is not publicly documented or supported, and Danalock could change
  it at any time.

## Acknowledgements

The API behaviour this plugin relies on was documented by the community, in particular
[erikwihlborg76/unofficial-danalock-web-api](https://github.com/erikwihlborg76/unofficial-danalock-web-api)
and [furth3st/ha-danalock-cloud](https://github.com/furth3st/ha-danalock-cloud).

This project is not affiliated with, endorsed by, or supported by Danalock or Salto.

## License

[MIT](LICENSE)
