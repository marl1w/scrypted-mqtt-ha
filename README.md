# Scrypted MQTT

One Home Assistant device per Scrypted camera, with everything Scrypted knows about it: live view, snapshots, motion, occupancy, detections, the camera's controls, and entities that other Scrypted plugins add. Everything goes through your MQTT broker.

| Part | Where | What it does |
|---|---|---|
| [`scrypted-plugin/`](scrypted-plugin) | Scrypted | **Scrypted MQTT** plugin: publishes the cameras you select, and relays add-ons from other plugins |
| [`custom_components/scrypted_mqtt/`](custom_components/scrypted_mqtt) | Home Assistant | **Scrypted MQTT** integration: builds the devices and entities from those topics |
| [`docs/contract.md`](docs/contract.md) | — | The topics and payloads both sides follow |

## What each camera gets

- **Camera**: live view from Scrypted's rebroadcast (WebRTC through Home Assistant's go2rtc), snapshots taken by Scrypted.
- **Sensors** from the camera's Scrypted interfaces: online, motion, occupancy, sound, battery, and an **Object detected** event per detection class.
- **Devices that belong to the camera**: its children (siren, floodlight, day/night) and its mixins' sensors named after it (for example presence or tamper), as switches and binary sensors on the same device, read from their standard Scrypted interfaces.
- **Raw signals**: the camera's own motion and AI classes as `Camera motion`, `Camera person`, … next to the verified ones: from the camera plugin's `Camera <signal>` child sensors where it has them, else (classes only) from the camera's own detection events, leaving out those of its mixins.
- **Add-ons**: for what no standard interface carries, any Scrypted plugin can add entities to a camera (contract section 10), pictures included (an image entity, such as the last verified detection). States are exact: on and off as the plugin reports them, with no timers.

## Upgrading to 0.2.0

The bridge now reads what other plugins expose through standard interfaces, and its entities take over the add-on entities they duplicate, keeping their entity ids and history. Upgrade in this order:

1. the **integration** (HACS), and restart Home Assistant;
2. the **bridge** (Scrypted plugin);
3. once the entities show `bridge` unique ids in Home Assistant, the **add-ons** may stop publishing what the bridge now reads.

**Rolling back.** Roll back the bridge first and keep integration 0.2.0: it hands every entry back to the add-on entity it came from (same entity id, history and customisations). Then roll back the integration if you must. An integration older than 0.2.0 does not know about hand-overs: with a 0.2.0 bridge it shows the add-on entities again beside the bridge's, under new `_2` entity ids, until the integration is 0.2.0 again, which removes those copies (their history stays under the `_2` ids).

## Install

Requirements: Home Assistant 2026.1 or newer with the MQTT integration set up, and Scrypted on a host Home Assistant can reach.

1. **Scrypted**: build and deploy the plugin (`cd scrypted-plugin && npm install && npm run build && npx scrypted-deploy <scrypted-host>:10443`). In its settings enter the broker URL and credentials, then select the cameras to publish.
2. **Home Assistant**: HACS → **⋮** → **Custom repositories** → add this repository as an **Integration**, install **Scrypted MQTT**, restart, then **Settings → Devices & services → Add integration → Scrypted MQTT**. The only setting is the topic root (default `scrypted`).

**Stream host** in the plugin is the address Home Assistant uses to reach Scrypted's rebroadcast. Keep `127.0.0.1` when Scrypted runs as a Home Assistant add-on or otherwise shares the host network.

**Audio**: with Stream audio on, Home Assistant's go2rtc transcodes the camera's AAC to Opus in an ffmpeg of its own, which starts late and lags the live view. To avoid it, add a Rebroadcast synthetic stream named `opus` to the camera (Rebroadcast → Synthetic Streams; input: the prebuffered stream; parser FFmpeg (TCP); output prefix `-c:v copy -c:a libopus -application:a lowdelay -frame_duration 20 -ar:a 48000 -ac:a 1 -b:a 32k -muxdelay 0`) and leave it unprebuffered: the bridge then gives Home Assistant that stream, which transcodes only while someone watches (a few % of a core per viewer). For the High resolution camera, add `opus-high` the same way with the highest-resolution stream as its input. The names follow the bridge's Opus stream setting.

**High resolution**: a camera whose highest-resolution stream is not its default one gets a second camera entity, **High resolution**, enabled like the main one but hidden, so dashboards and HA's Security page list each camera once; it stays on the device page. Leave that stream unprebuffered in Rebroadcast: Scrypted then opens a main-stream session to the camera only while someone watches it, and the default camera keeps serving dashboards and snapshots.

**Recorder**: an add-on's pictures (such as the last detection) change their entity's state each time. To keep them out of the history database:

```yaml
recorder:
  exclude:
    entity_globs:
      - image.*_last_detection
```

## Security

Stream URLs carry Scrypted's rebroadcast token and are retained on the broker, so anyone who can read the topic root can watch the cameras, and anyone who can write it can switch the cameras' sirens and floodlights. Give the broker a login, and when other users or add-ons share it, the ACL in [contract section 11](docs/contract.md#11-security). Use `mqtts://` for a broker on another host.

## Development

```
cd scrypted-plugin && npm install && npm test   # plugin
python -m pytest                                # integration (needs pytest-homeassistant-custom-component)
```

## License

MIT, see [LICENSE](LICENSE).
