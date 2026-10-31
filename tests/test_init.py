"""End-to-end tests: MQTT messages in, devices and entities out."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_mqtt_message

from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from custom_components.scrypted_mqtt.const import DOMAIN

ROOT = "scrypted"
STREAM = "rtsp://127.0.0.1:40000/0123abcd"


def bridge_config(name: str = "Front door", entities: list | None = None, stream: str | None = STREAM) -> str:
    device = {"name": name, "model": "Cam 1", "manufacturer": "Example"}
    if stream:
        device["stream"] = stream
    if entities is None:
        entities = [
            {"key": "online", "name": "Online", "platform": "binary_sensor", "device_class": "connectivity", "category": "diagnostic"},
            {"key": "motion", "name": "Motion", "platform": "binary_sensor", "device_class": "motion"},
            {"key": "detection", "name": "Object detected", "platform": "event", "event_types": ["person"]},
            {"key": "child_7", "name": "Siren", "platform": "switch"},
        ]
    return json.dumps({"v": 1, "device": device, "entities": entities})


GUARD = json.dumps(
    {
        "v": 1,
        "entities": [
            {"key": "person", "name": "Person presence", "platform": "binary_sensor", "device_class": "occupancy", "object_id": "front_door_person_occupancy"},
        ],
    }
)


@pytest.fixture
async def setup(hass: HomeAssistant, mqtt_mock):
    """The integration set up on the mocked broker."""
    entry = MockConfigEntry(domain=DOMAIN, data={"root": ROOT}, title="Scrypted MQTT")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    yield entry
    if entry.state.recoverable:
        await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()


def fire(hass: HomeAssistant, topic: str, payload: str | bytes, retain: bool = False) -> None:
    """A live publish: a broker delivers it to existing subscribers without the retain flag."""
    async_fire_mqtt_message(hass, f"{ROOT}/{topic}", payload, retain=retain)


async def publish_camera(hass: HomeAssistant) -> None:
    fire(hass, "sources/bridge/status", "online")
    fire(hass, "devices/42/bridge/config", bridge_config())
    fire(hass, "devices/42/bridge/state/motion", "ON")
    fire(hass, "devices/42/bridge/state/online", "ON")
    await hass.async_block_till_done()


async def test_one_device_with_camera_and_entities(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, f"{ROOT}:42")})
    assert device is not None
    assert (device.name, device.model, device.manufacturer) == ("Front door", "Cam 1", "Example")
    entities = er.async_entries_for_device(er.async_get(hass), device.id)
    assert sorted(e.entity_id for e in entities) == [
        "binary_sensor.front_door_motion",
        "binary_sensor.front_door_online",
        "camera.front_door",
        "event.front_door_object_detected",
        "switch.front_door_siren",
    ]
    assert hass.states.get("binary_sensor.front_door_motion").state == STATE_ON
    assert hass.states.get("switch.front_door_siren").state == STATE_UNKNOWN


async def test_add_on_entities_join_the_device_with_their_object_id(hass: HomeAssistant, setup) -> None:
    fire(hass, "devices/42/guard/config", GUARD)
    fire(hass, "devices/42/guard/state/person", "ON")
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.front_door_person_occupancy") is None  # no device yet
    await publish_camera(hass)
    state = hass.states.get("binary_sensor.front_door_person_occupancy")
    assert state.state == STATE_ON
    entry = er.async_get(hass).async_get("binary_sensor.front_door_person_occupancy")
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, f"{ROOT}:42")})
    assert entry.device_id == device.id


async def test_availability_follows_bridge_and_source_status(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    fire(hass, "devices/42/guard/config", GUARD)
    await hass.async_block_till_done()
    fire(hass, "sources/guard/status", "offline")
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.front_door_person_occupancy").state == STATE_UNAVAILABLE
    assert hass.states.get("binary_sensor.front_door_motion").state == STATE_ON
    fire(hass, "sources/bridge/status", "offline")
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.front_door_motion").state == STATE_UNAVAILABLE
    assert hass.states.get("camera.front_door").state == STATE_UNAVAILABLE


async def test_entities_dropped_from_a_config_and_withdrawn_devices_are_removed(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[{"key": "motion", "name": "Motion", "platform": "binary_sensor"}]))
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get("switch.front_door_siren") is None
    assert registry.async_get("binary_sensor.front_door_motion") is not None
    fire(hass, "devices/42/bridge/config", "")
    await hass.async_block_till_done()
    assert dr.async_get(hass).async_get_device(identifiers={(DOMAIN, f"{ROOT}:42")}) is None
    assert registry.async_get("binary_sensor.front_door_motion") is None


async def test_renamed_entities_keep_their_id_across_config_changes(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    registry = er.async_get(hass)
    registry.async_update_entity("binary_sensor.front_door_motion", new_entity_id="binary_sensor.front_door_verified_motion")
    fire(hass, "devices/42/bridge/config", bridge_config(name="Front gate"))
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.front_door_verified_motion").state == STATE_ON
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, f"{ROOT}:42")})
    assert device.name == "Front gate"


async def test_detection_events_fire_with_learnt_types(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    fire(hass, "devices/42/bridge/event/detection", '{"event_type":"verified_person","attributes":{"score":1}}')
    await hass.async_block_till_done()
    state = hass.states.get("event.front_door_object_detected")
    assert state.attributes["event_type"] == "verified_person"
    assert state.attributes["score"] == 1
    assert "verified_person" in state.attributes["event_types"]


async def test_switch_sends_commands_and_shows_only_confirmed_state(hass: HomeAssistant, setup, mqtt_mock) -> None:
    await publish_camera(hass)
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.front_door_siren"}, blocking=True)
    assert mqtt_mock.async_publish.call_args[0][:4] == (f"{ROOT}/devices/42/bridge/set/child_7", "ON", 1, False)
    assert hass.states.get("switch.front_door_siren").state == STATE_UNKNOWN
    fire(hass, "devices/42/bridge/state/child_7", "OFF")
    await hass.async_block_till_done()
    assert hass.states.get("switch.front_door_siren").state == STATE_OFF


async def test_camera_streams_from_the_bridge_and_snapshots_over_mqtt(hass: HomeAssistant, setup, mqtt_mock) -> None:
    await publish_camera(hass)
    camera = hass.data["camera"].get_entity("camera.front_door")
    assert await camera.stream_source() == STREAM

    async def reply(*_args) -> None:
        request = json.loads(mqtt_mock.async_publish.call_args[0][1])
        assert request["width"] == 640
        fire(hass, f"devices/42/bridge/snapshot/{request['id']}", b"\xff\xd8jpeg")

    task = asyncio.ensure_future(camera.async_camera_image(width=640))
    for _ in range(5):
        await asyncio.sleep(0)
    await reply()
    assert await task == b"\xff\xd8jpeg"


async def test_snapshot_times_out_to_none(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    camera = hass.data["camera"].get_entity("camera.front_door")
    with patch("custom_components.scrypted_mqtt.hub.SNAPSHOT_TIMEOUT", 0.01):
        assert await camera.async_camera_image() is None


async def test_unload(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    assert await hass.config_entries.async_unload(setup.entry_id)
    await hass.async_block_till_done()


async def test_config_flow(hass: HomeAssistant, mqtt_mock) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "form"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"root": "bad/#"})
    assert result["errors"] == {"root": "invalid_root"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"root": "/scrypted/"})
    assert result["type"] == "create_entry"
    assert result["data"] == {"root": "scrypted"}


async def test_object_id_outside_the_device_name_is_ignored(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    claim = json.dumps({"v": 1, "entities": [{"key": "x", "name": "Thing", "platform": "binary_sensor", "object_id": "back_door_motion"}]})
    fire(hass, "devices/42/guard/config", claim)
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.back_door_motion") is None
    assert hass.states.get("binary_sensor.front_door_thing") is not None


async def test_oversized_configs_are_dropped(hass: HomeAssistant, setup) -> None:
    await publish_camera(hass)
    big = json.dumps({"v": 1, "entities": [], "pad": "x" * 70000})
    fire(hass, "devices/42/guard/config", big)
    await hass.async_block_till_done()
    assert setup.runtime_data._sources.get("42", {}).get("guard") is None


async def test_snapshot_replies_only_count_for_their_device_and_widths_are_bucketed(hass: HomeAssistant, setup, mqtt_mock) -> None:
    await publish_camera(hass)
    camera = hass.data["camera"].get_entity("camera.front_door")
    with patch("custom_components.scrypted_mqtt.hub.SNAPSHOT_TIMEOUT", 0.2):
        task = asyncio.ensure_future(camera.async_camera_image(width=500))
        for _ in range(5):
            await asyncio.sleep(0)
        request = json.loads(mqtt_mock.async_publish.call_args[0][1])
        assert request["width"] == 640
        fire(hass, f"devices/7/bridge/snapshot/{request['id']}", b"wrong")
        await hass.async_block_till_done()
        assert await task is None
