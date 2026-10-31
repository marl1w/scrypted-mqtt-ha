# Scrypted MQTT

One Home Assistant device per Scrypted camera, with everything Scrypted knows about it: live view, snapshots, motion, occupancy, detections, the camera's controls, and entities that other Scrypted plugins add. Everything goes through your MQTT broker.

| Part | Where | What it does |
|---|---|---|
| [`scrypted-plugin/`](scrypted-plugin) | Scrypted | **Scrypted MQTT** plugin: publishes the cameras you select, and relays add-ons from other plugins |
| [`custom_components/scrypted_mqtt/`](custom_components/scrypted_mqtt) | Home Assistant | **Scrypted MQTT** integration: builds the devices and entities from those topics |
| [`docs/contract.md`](docs/contract.md) | — | The topics and payloads both sides follow |

## What each camera gets

- **Camera**: live view from Scrypted's rebroadcast (WebRTC through Home Assistant's go2rtc), snapshots taken by Scrypted.
- **Sensors** from the camera's Scrypted interfaces: online, motion, occupancy, battery, and an **Object detected** event per detection class.
- **Child devices** of the camera (siren, floodlight, extra sensors) as switches and binary sensors on the same device.
- **Add-ons**: any Scrypted plugin can add entities to a camera (contract section 10), pictures included (an image entity, such as the last verified detection). States are exact: on and off as the plugin reports them, with no timers.

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
