# Scrypted MQTT contract (v1)

The agreement between whatever publishes camera data from Scrypted and the Home Assistant integration that turns it into devices. Both sides are built from it; neither may rely on anything not written here.

## 1. Parts

| Part | Runs in | Job |
|---|---|---|
| **Bridge** | Scrypted (`scrypted-plugin/`) | Publishes each selected camera: its description, its stream, its standard sensors and controls, and its snapshots. Owns the broker connection. Relays add-ons from other Scrypted plugins. |
| **Add-on** | any Scrypted plugin (section 10), or anything that can reach the broker | Adds entities to a camera the bridge publishes. |
| **Integration** | Home Assistant (`custom_components/scrypted_mqtt/`) | Builds one device per camera from everything published for it. Knows nothing about cameras, brands or detectors. |

Everything a camera shows in Home Assistant comes from a **source**. The bridge is the source named `bridge`; it is the only one that may describe the device itself.

## 2. Identifiers

| Name | Form | Example |
|---|---|---|
| `root` | topic prefix, configurable on both sides | `scrypted` |
| `device` | the camera's Scrypted device id, `[0-9A-Za-z_-]{1,64}`. Stable across renames. | `42` |
| `source` | publisher name, `[a-z0-9][a-z0-9-]{0,31}` | `bridge`, `coral-guard` |
| `key` | entity key, `[a-z0-9][a-z0-9_]{0,63}`, unique within its source and device | `motion`, `person` |

## 3. Topics

```
<root>/sources/<source>/status                        online | offline        retained
<root>/devices/<device>/<source>/config               JSON (section 4)        retained
<root>/devices/<device>/<source>/state/<key>          state (section 5)       retained
<root>/devices/<device>/<source>/event/<key>          JSON (section 5)        not retained
<root>/devices/<device>/<source>/set/<key>            command (section 6)     not retained, written by the integration
<root>/devices/<device>/bridge/snapshot/request       JSON (section 7)        not retained, written by the integration
<root>/devices/<device>/bridge/snapshot/<request id>  JPEG bytes              not retained
```

The bridge's own status topic is its MQTT last will, so the broker marks it `offline` when the bridge disappears. A source writes only under its own `<source>` segment; the integration writes only `set` and `snapshot/request` topics.

## 4. Config payload

```json
{
  "v": 1,
  "device": {
    "name": "Front door",
    "model": "Doorbell 2",
    "manufacturer": "Example",
    "stream": "rtsp://127.0.0.1:40000/0123456789abcdef",
    "streams": [{ "key": "high", "name": "High resolution", "url": "rtsp://127.0.0.1:40000/fedcba9876543210" }]
  },
  "entities": [
    { "key": "motion", "name": "Motion", "platform": "binary_sensor", "device_class": "motion" }
  ]
}
```

- `v`: contract major version. The integration ignores a config with a major it does not know and logs it once.
- `device`: **only the `bridge` source sends it**, and the integration ignores it from any other source. `stream` is the RTSP URL Home Assistant plays; it may be missing (no live view, snapshots only). `streams` lists further streams, `{"key", "name", "url"}` each (`key` as in section 2, at most 4), and each becomes one more camera entity on the device (the bridge sends the highest-resolution stream as `high`, "High resolution", when it is not the main one). Optional: `model`, `manufacturer`, `sw_version`, `streams`.
- `entities`: the full list this source provides for this device, at most 64. A new config replaces the previous list: entities missing from it are removed.
- An empty retained payload withdraws the config: the source's entities on that device are removed, and if the source is `bridge`, the device with everything on it.

### Entity fields

| Field | Required | Meaning |
|---|---|---|
| `key` | yes | see section 2 |
| `name` | yes | shown after the device name, at most 64 characters |
| `platform` | yes | `binary_sensor`, `sensor`, `switch`, `button` or `event` |
| `device_class` | no | a Home Assistant device class valid for the platform |
| `unit` | no | `sensor` only |
| `state_class` | no | `sensor` only: `measurement`, `total`, `total_increasing` |
| `event_types` | no | `event` only: the values known up front |
| `category` | no | `diagnostic` or `config` |
| `enabled` | no | `false` creates the entity disabled. Default `true`. |
| `icon` | no | `mdi:…` |
| `object_id` | no | entity id (without the platform) to use the **first** time the entity is created, `[a-z0-9_]+`. Ignored afterwards, so a rename made in Home Assistant is kept. Default: the device name plus the entity name, as Home Assistant derives it. |

## 5. States and events

| Platform | Payload on `state/<key>` |
|---|---|
| `binary_sensor`, `switch` | `ON` or `OFF` |
| `sensor` | the value as text, at most 255 characters |
| `button`, `event` | none |
| any | empty payload means unknown |

States are published retained, only when they change, and once after the config so a new subscriber never waits.

Events go to `event/<key>`, not retained:

```json
{ "event_type": "person", "attributes": { "score": 0.91 } }
```

`event_type` follows the key rules of section 2 except that it may contain `-`. A type not in `event_types` is accepted and added to the entity's types.

## 6. Commands

The integration publishes `ON`, `OFF` (switch) or `PRESS` (button) to `set/<key>`. The source carries out the command and then publishes the resulting state. The integration shows only states, never what it asked for, so a failed command leaves the switch where the device really is.

## 7. Snapshots

The integration publishes `{"id": "<request id>", "width": 640}` to `bridge/snapshot/request` (`id` is `[A-Za-z0-9_-]{1,64}`; `width` and `height` are optional) and waits up to 10 s for the JPEG on `bridge/snapshot/<request id>`. The integration rounds widths up to 320, 640, 1280 or 1920. The bridge takes one picture at a time per camera whatever the size asked, and a finished picture answers every request for 3 s; Home Assistant scales it down. An empty reply means the camera could not take one.

## 8. Lifecycle

| Situation | What the source does | What the integration does |
|---|---|---|
| Source starts | `status` = `online`, then configs, then states | marks its entities available |
| Source stops or crashes | `offline` (the bridge's last will, or the bridge on behalf of a silent add-on) | marks that source's entities unavailable; other sources' stay as they are |
| Camera selected in the bridge | bridge publishes its config | creates the device, its camera entity and the bridge's entities |
| Add-on config arrives before the bridge's | — | keeps it and applies it when the device appears |
| Camera renamed in Scrypted | bridge republishes its config | renames the device; entity ids are unchanged |
| Entity dropped from a config | republishes the config without it | removes the entity |
| Camera deselected or deleted | bridge withdraws its config and clears its states; add-ons withdraw theirs | removes the device and everything on it |
| `bridge` offline | — | the whole device, camera included, is unavailable |

## 9. Home Assistant mapping

- Device identifier: `("scrypted_mqtt", "<root>:<device>")`.
- Camera entity: unique id `<root>:<device>:camera`, named after the device; one more per extra stream, unique id `<root>:<device>:camera:<key>`, named by the stream's `name`. Plays `device.stream` (Home Assistant's go2rtc gives live view over WebRTC) and takes snapshots through section 7.
- Other entities: unique id `<root>:<device>:<source>:<key>`.
- The integration subscribes to `<root>/#` through Home Assistant's MQTT integration and needs no setting other than `root`.

## 10. Bridge

Settings: broker URL, user, password, `root`, the cameras to publish (none by default), the host Home Assistant uses to reach Scrypted's rebroadcast (default `127.0.0.1`, for a Scrypted that shares the host network with Home Assistant), and whether the stream carries audio (default off: the muted rebroadcast, which WebRTC plays without transcoding the camera's AAC audio).

The stream is the Rebroadcast plugin's RTSP URL of the camera's default stream (as set in Rebroadcast, so a cropped view where one is configured; otherwise a prebuffered stream), which Scrypted already keeps open, so live view adds no connection to the camera.

Base entities, each present only when the camera has the matching Scrypted interface:

| Key | Platform | From |
|---|---|---|
| `online` | binary_sensor `connectivity`, diagnostic | `Online` |
| `motion` | binary_sensor `motion` | `MotionSensor`, after any mixin |
| `occupancy` | binary_sensor `occupancy` | `OccupancySensor` |
| `detection` | event | `ObjectDetector`. One event per distinct class in each detection payload, `motion` skipped, `event_type` = class name, attributes `label`, `score` (two decimals) and `zones`. At most one event per class every 5 s: a class that stays in view keeps firing at that pace. |
| `battery` | sensor `battery`, `%`, diagnostic | `Battery` |

Each child device of the camera (its `providerId` is the camera) that is not a camera itself becomes entities on the camera's device, keyed `child_<child id>`, named after the child without the camera's name: `OnOff` as a switch, else `OccupancySensor`, `MotionSensor` or `BinarySensor` as a binary sensor.

### Add-ons inside Scrypted

A Scrypted plugin hands its add-on to the bridge over Scrypted's event bus, with no broker settings of its own:

- The add-on emits device events on its own plugin device with the interface name `ScryptedMqttAddon` and one of these payloads (`v` is 1). Scrypted forwards such events only to listeners of that device, so the bridge listens on every plugin device:

  ```
  { v, type: "config", source, device, entities }           section 4, without "device"
  { v, type: "withdraw", source, device }
  { v, type: "state",  source, device, key, value }          value: "ON", "OFF", text, or null for unknown
  { v, type: "event",  source, device, key, event_type, attributes }
  { v, type: "alive",  source }                              at start and every 30 s
  ```

- The bridge emits `ScryptedMqttBridge` events on its own plugin device:

  ```
  { v, type: "hello" }                                       bridge (re)started: send everything again
  { v, type: "command", source, device, key, value }         forwarded from set/<key>
  ```

  An add-on finds the bridge with `systemManager.getDeviceById("@marl1w/scrypted-mqtt")` and listens to that device.

- An add-on sends everything again when it first finds the bridge and on every `hello`, and acts only on commands for keys it declared.
- The bridge publishes an add-on only for cameras it publishes and devices Scrypted knows, drops anything that does not validate (at most 32 sources, 256 devices each), publishes `status` `online` on the first message of a source and `offline` after 90 s without one, and keeps the last config and states of every source so a broker reconnection needs nothing from the add-ons.
- Retained topics a source set in an earlier run and did not set again are cleared 2 minutes after the bridge connects, but only for sources heard from in this run; the others are checked again at every refresh.

A program outside Scrypted may instead publish to the broker itself and follow sections 3 to 8.

## 11. Security

- **Reading** `<root>/#` means watching the cameras: stream URLs carry Scrypted's rebroadcast token and are retained.
- **Writing** `<root>/#` means controlling them: a forged config can point Home Assistant at another RTSP host or create devices, and a `set` topic switches sirens and floodlights. A broker login alone is therefore not enough when other users or add-ons share the broker.
- Recommended ACL (Mosquitto `acl_file`, with the bridge logging in as `scrypted` and Home Assistant as `homeassistant`):

  ```
  user scrypted
  topic readwrite scrypted/#

  user homeassistant
  topic read scrypted/#
  topic write scrypted/devices/+/+/set/#
  topic write scrypted/devices/+/bridge/snapshot/request
  ```

- Use `mqtts://` when the broker is on another host: `mqtt://` sends the password and the stream tokens in clear. Credentials go in the Username and Password settings; the bridge refuses a broker URL that contains them.
- The bridge acts only on `set` and `snapshot/request` topics of cameras it publishes, and only on keys it or a live add-on declared. The integration drops configs over 64 KB, events over 4 KB and snapshots over 10 MB, bounds what it keeps per device and source, takes an `object_id` only under the device's own name, and accepts a snapshot only from the device it asked.
