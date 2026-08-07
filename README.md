# homebridge-danalock

[![npm](https://img.shields.io/npm/v/homebridge-danalock.svg)](https://www.npmjs.com/package/homebridge-danalock)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Homebridge](https://homebridge.io) plugin that exposes **Danalock V3** smart locks in Apple
HomeKit, so you can lock and unlock them from the Home app, Siri, and automations.

Each lock appears as a HomeKit **Lock Mechanism**, with its **battery level** reported as part of
the same accessory.

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

Search for **Danalock** in the Homebridge UI's plugin tab and install it, or from the command line:

```bash
npm install -g homebridge-danalock
```

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
| `pollInterval` | number | `10` | Seconds between state-refresh rounds. Controls how quickly changes made *outside* HomeKit are noticed. Minimum 5. |
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

## How it works

The V3-BT speaks only Bluetooth, and the Danabridge is **cloud-only by design** — it has no local
API, and stops working entirely without internet access. So every command travels:

```
Homebridge → Danalock cloud → your Danabridge → Bluetooth → the lock
```

The plugin authenticates against the Danalock cloud, discovers your locks, and issues operations
through the bridge service, polling each job until it completes.

### Concurrency

A Danabridge processes **one operation at a time**; overlapping requests fail with a "bridge busy"
error. At startup the plugin works out which Danabridge each lock is paired with, and serialises
operations **per bridge**:

- Locks behind **different** bridges are polled and operated **in parallel**.
- Locks sharing **one** bridge queue up behind each other automatically.

If a lock's bridge can't be determined, the plugin logs a warning and falls back to serialising
that lock with everything else — slower, but it never hammers a bridge.

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

## Troubleshooting

**The lock shows "No Response".**
The plugin could not verify the lock's state after `unresponsiveThreshold` consecutive attempts.
This is deliberate: rather than keep displaying a possibly-wrong "Locked", it reports that the
state is unknown. Check the Danabridge is powered on, online, and within Bluetooth range of the
lock. Locks behind other bridges are unaffected.

**"Could not determine the Danabridge paired with …"**
The plugin could not resolve which bridge that lock uses, so it fell back to a shared queue and
operations won't run in parallel. Confirm the lock is paired with a Danabridge in the Danalock app.

**Frequent "bridge busy" messages.**
Something else is talking to the same bridge — the Danalock app, or another Homebridge instance.
Raising `pollInterval` will reduce the contention.

**Authentication failures.**
Verify the email and password by signing in at [my.danalock.com](https://my.danalock.com). Run
Homebridge with `-D` for debug logging; credentials and tokens are never logged.

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

## Acknowledgements

The API behaviour this plugin relies on was documented by the community, in particular
[erikwihlborg76/unofficial-danalock-web-api](https://github.com/erikwihlborg76/unofficial-danalock-web-api)
and [furth3st/ha-danalock-cloud](https://github.com/furth3st/ha-danalock-cloud).

This project is not affiliated with, endorsed by, or supported by Danalock or Salto.

## License

[MIT](LICENSE)
