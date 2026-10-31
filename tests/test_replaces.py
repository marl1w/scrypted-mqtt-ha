"""The bridge's entities that take over add-on entities: no duplicates, and the registry entry (entity id, history,
area, labels, name) carried over to the bridge's unique id."""

from __future__ import annotations

import json
from unittest.mock import patch

from homeassistant.const import STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er

from custom_components.scrypted_mqtt.const import DOMAIN

from .test_init import ROOT, bridge_config, fire, setup  # noqa: F401

PRESENCE_ID = "binary_sensor.front_door_person_occupancy"
RAW_ID = "binary_sensor.front_door_camera_person"

BASE = [{"key": "motion", "name": "Motion", "platform": "binary_sensor", "device_class": "motion"}]
FOLDED = {"key": "child_20", "name": "Person Presence", "platform": "binary_sensor", "device_class": "occupancy", "replaces": ["guard:person"]}
RAW = {"key": "camera_person", "name": "Camera person", "platform": "binary_sensor", "device_class": "occupancy", "replaces": ["cam:people"]}

GUARD = json.dumps(
    {
        "v": 1,
        "entities": [
            {"key": "person", "name": "Person presence", "platform": "binary_sensor", "device_class": "occupancy", "object_id": "front_door_person_occupancy"},
            {"key": "last_detection", "name": "Last detection", "platform": "image", "object_id": "front_door_last_detection"},
        ],
    }
)
CAM = json.dumps(
    {
        "v": 1,
        "entities": [
            {"key": "people", "name": "Camera person", "platform": "binary_sensor", "device_class": "occupancy", "object_id": "front_door_camera_person"},
            {"key": "face", "name": "Camera face", "platform": "binary_sensor", "device_class": "occupancy", "object_id": "front_door_camera_face"},
        ],
    }
)


def uid(source: str, key: str) -> str:
    return f"{ROOT}:42:{source}:{key}"


async def start(hass: HomeAssistant, entities: list) -> None:
    fire(hass, "sources/bridge/status", "online")
    fire(hass, "devices/42/guard/config", GUARD)
    fire(hass, "devices/42/guard/state/person", "ON")
    fire(hass, "devices/42/cam/config", CAM)
    fire(hass, "devices/42/cam/state/people", "ON")
    fire(hass, "devices/42/bridge/config", bridge_config(entities=entities))
    await hass.async_block_till_done()


async def test_live_add_on_entities_move_to_the_bridge_with_their_customisations(hass: HomeAssistant, setup) -> None:
    # an earlier bridge: the add-ons' entities are live
    await start(hass, BASE)
    registry = er.async_get(hass)
    assert registry.async_get(PRESENCE_ID).unique_id == uid("guard", "person")
    assert registry.async_get(RAW_ID).unique_id == uid("cam", "people")
    area = ar.async_get(hass).async_create("Garden")
    registry.async_update_entity(PRESENCE_ID, area_id=area.id, labels={"security"}, name="Someone at the door")
    created = registry.async_get(PRESENCE_ID).created_at

    # the new bridge folds the same signals in from standard interfaces
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED, RAW]))
    fire(hass, "devices/42/bridge/state/child_20", "OFF")
    fire(hass, "devices/42/bridge/state/camera_person", "OFF")
    await hass.async_block_till_done()

    entry = registry.async_get(PRESENCE_ID)
    assert entry.unique_id == uid("bridge", "child_20")
    assert (entry.area_id, entry.labels, entry.name, entry.created_at) == (area.id, {"security"}, "Someone at the door", created)
    assert registry.async_get(RAW_ID).unique_id == uid("bridge", "camera_person")
    assert hass.states.get(PRESENCE_ID).state == STATE_OFF
    assert hass.states.get(RAW_ID).state == STATE_OFF

    # the add-ons' duplicates are ignored; their other entities stay
    fire(hass, "devices/42/guard/state/person", "ON")
    fire(hass, "devices/42/cam/state/people", "ON")
    await hass.async_block_till_done()
    assert hass.states.get(PRESENCE_ID).state == STATE_OFF
    assert hass.states.get(RAW_ID).state == STATE_OFF
    assert registry.async_get_entity_id("binary_sensor", DOMAIN, uid("guard", "person")) is None
    assert registry.async_get_entity_id("binary_sensor", DOMAIN, uid("cam", "people")) is None
    assert registry.async_get("image.front_door_last_detection") is not None
    assert registry.async_get("binary_sensor.front_door_camera_face") is not None
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, f"{ROOT}:42")})
    ids = sorted(e.entity_id for e in er.async_entries_for_device(registry, device.id))
    assert ids == [
        "binary_sensor.front_door_camera_face",
        RAW_ID,
        "binary_sensor.front_door_motion",
        PRESENCE_ID,
        "camera.front_door",
        "image.front_door_last_detection",
    ]

    # the bridge's state follows its own topic
    fire(hass, "devices/42/bridge/state/child_20", "ON")
    await hass.async_block_till_done()
    assert hass.states.get(PRESENCE_ID).state == STATE_ON


async def test_registered_add_on_entities_move_before_any_is_created(hass: HomeAssistant, setup) -> None:
    # left in the registry by an earlier run (Home Assistant restarted with the new bridge's config retained)
    registry = er.async_get(hass)
    registry.async_get_or_create(
        "binary_sensor", DOMAIN, uid("guard", "person"), config_entry=setup, suggested_object_id="front_door_person_occupancy"
    )
    await start(hass, [*BASE, FOLDED])
    entry = registry.async_get(PRESENCE_ID)
    assert entry.unique_id == uid("bridge", "child_20")
    assert hass.states.get(PRESENCE_ID).state not in (None, STATE_ON)  # the bridge's state, not the add-on's
    assert registry.async_get("binary_sensor.front_door_person_presence") is None


async def test_the_older_entry_wins_over_one_the_bridge_made_first(hass: HomeAssistant, setup) -> None:
    # the bridge folded the sensor before it heard the add-on, so it had no replaces yet
    await start(hass, BASE)
    registry = er.async_get(hass)
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, {**FOLDED, "replaces": []}]))
    await hass.async_block_till_done()
    assert registry.async_get("binary_sensor.front_door_person_presence").unique_id == uid("bridge", "child_20")
    assert registry.async_get(PRESENCE_ID).unique_id == uid("guard", "person")

    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    assert registry.async_get(PRESENCE_ID).unique_id == uid("bridge", "child_20")
    assert registry.async_get("binary_sensor.front_door_person_presence") is None
    assert hass.states.get("binary_sensor.front_door_person_presence") is None


async def test_without_a_registered_add_on_entity_the_bridge_creates_its_own_once(hass: HomeAssistant, setup) -> None:
    await start(hass, [*BASE, FOLDED])
    registry = er.async_get(hass)
    assert registry.async_get(PRESENCE_ID) is None
    assert registry.async_get("binary_sensor.front_door_person_presence").unique_id == uid("bridge", "child_20")


async def test_only_the_bridge_can_replace(hass: HomeAssistant, setup) -> None:
    await start(hass, BASE)
    fire(
        hass,
        "devices/42/other/config",
        json.dumps({"v": 1, "entities": [{"key": "x", "name": "X", "platform": "binary_sensor", "replaces": ["guard:person"]}]}),
    )
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get(PRESENCE_ID).unique_id == uid("guard", "person")
    assert registry.async_get("binary_sensor.front_door_x") is not None


async def test_dropping_the_replacing_entity_hands_its_entry_to_the_add_on(hass: HomeAssistant, setup) -> None:
    # the bridge's entity came first (no add-on entry to take over)
    await start(hass, [*BASE, FOLDED])
    registry = er.async_get(hass)
    bridge_id = "binary_sensor.front_door_person_presence"
    registry.async_update_entity(bridge_id, labels={"security"})
    fire(hass, "devices/42/bridge/config", bridge_config(entities=BASE))
    await hass.async_block_till_done()
    entry = registry.async_get(bridge_id)
    assert (entry.unique_id, entry.labels) == (uid("guard", "person"), {"security"})
    assert hass.states.get(bridge_id).state == STATE_ON
    assert registry.async_get(PRESENCE_ID) is None


async def test_a_bridge_restart_that_briefly_does_not_replace_keeps_the_migrated_entry(hass: HomeAssistant, setup) -> None:
    await start(hass, BASE)
    registry = er.async_get(hass)
    registry.async_update_entity(PRESENCE_ID, labels={"security"})
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    assert registry.async_get(PRESENCE_ID).unique_id == uid("bridge", "child_20")

    # the bridge briefly does not name the add-on's entity: it is still not created beside the one that took it over
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, {**FOLDED, "replaces": []}]))
    await hass.async_block_till_done()
    assert registry.async_get(f"{PRESENCE_ID}_2") is None
    assert registry.async_get_entity_id("binary_sensor", DOMAIN, uid("guard", "person")) is None

    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    entry = registry.async_get(PRESENCE_ID)
    assert (entry.unique_id, entry.labels) == (uid("bridge", "child_20"), {"security"})
    assert registry.async_get(f"{PRESENCE_ID}_2") is None
    assert hass.states.get(f"{PRESENCE_ID}_2") is None


async def test_a_camera_motion_device_takes_over_the_taps_motion_without_a_duplicate(hass: HomeAssistant, setup) -> None:
    motion_id = "binary_sensor.front_door_camera_motion"
    tap_motion = {"key": "camera_motion", "name": "Camera motion", "platform": "binary_sensor", "device_class": "motion", "replaces": ["cam:motion"]}
    cam_motion = json.dumps(
        {"v": 1, "entities": [{"key": "motion", "name": "Camera motion", "platform": "binary_sensor", "device_class": "motion", "object_id": "front_door_camera_motion"}]}
    )
    fire(hass, "sources/bridge/status", "online")
    fire(hass, "devices/42/cam/config", cam_motion)
    fire(hass, "devices/42/bridge/config", bridge_config(entities=BASE))
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get(motion_id).unique_id == uid("cam", "motion")
    registry.async_update_entity(motion_id, labels={"raw"})

    # the tap publishes it first
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, tap_motion]))
    await hass.async_block_till_done()
    assert registry.async_get(motion_id).unique_id == uid("bridge", "camera_motion")

    # then the camera plugin's exact-level device appears and replaces both
    child = {"key": "child_30", "name": "Camera motion", "platform": "binary_sensor", "device_class": "motion", "replaces": ["cam:motion", "bridge:camera_motion"]}
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, child]))
    fire(hass, "devices/42/bridge/state/child_30", "ON")
    await hass.async_block_till_done()
    entry = registry.async_get(motion_id)
    assert (entry.unique_id, entry.labels) == (uid("bridge", "child_30"), {"raw"})
    assert hass.states.get(motion_id).state == STATE_ON
    named = [e for e in registry.entities.values() if e.original_name == "Camera motion" or e.entity_id.startswith(motion_id)]
    assert [e.entity_id for e in named] == [motion_id]


async def test_a_rollback_hands_the_entry_back_losslessly(hass: HomeAssistant, setup) -> None:
    await start(hass, BASE)
    registry = er.async_get(hass)
    area = ar.async_get(hass).async_create("Garden")
    registry.async_update_entity(PRESENCE_ID, area_id=area.id, labels={"security"})
    for _ in range(2):
        # the bridge takes it over ...
        fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
        await hass.async_block_till_done()
        assert registry.async_get(PRESENCE_ID).unique_id == uid("bridge", "child_20")
        # ... and drops it again (a rollback, or the device no longer folded): the add-on gets its own entry back
        fire(hass, "devices/42/bridge/config", bridge_config(entities=BASE))
        await hass.async_block_till_done()
        entry = registry.async_get(PRESENCE_ID)
        assert (entry.unique_id, entry.area_id, entry.labels) == (uid("guard", "person"), area.id, {"security"})
        assert hass.states.get(PRESENCE_ID).state == STATE_ON
    assert [e.entity_id for e in registry.entities.values() if e.entity_id.startswith(PRESENCE_ID)] == [PRESENCE_ID]


async def test_the_customised_entry_wins_and_both_are_named(hass: HomeAssistant, setup, caplog) -> None:
    # the bridge's entry is older and plain; the add-on's came back later, got a _2 suffix and was customised
    await start(hass, [*BASE, {**FOLDED, "replaces": []}])
    registry = er.async_get(hass)
    bridge_id = "binary_sensor.front_door_person_presence"
    assert registry.async_get(bridge_id).unique_id == uid("bridge", "child_20")
    registry.async_update_entity(PRESENCE_ID, labels={"security"})
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    assert registry.async_get(bridge_id) is None
    entry = registry.async_get(PRESENCE_ID)
    assert (entry.unique_id, entry.labels) == (uid("bridge", "child_20"), {"security"})
    assert f"keeping {PRESENCE_ID}, removing {bridge_id}" in caplog.text


async def test_without_customisations_the_unsuffixed_entry_wins(hass: HomeAssistant, setup) -> None:
    await start(hass, BASE)
    registry = er.async_get(hass)
    # an entry the bridge made later, under a suffixed id
    registry.async_get_or_create("binary_sensor", DOMAIN, uid("bridge", "child_20"), config_entry=setup, suggested_object_id="front_door_person_occupancy")
    assert registry.async_get(f"{PRESENCE_ID}_2").unique_id == uid("bridge", "child_20")
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    assert registry.async_get(PRESENCE_ID).unique_id == uid("bridge", "child_20")
    assert registry.async_get(f"{PRESENCE_ID}_2") is None


async def test_a_failed_hand_over_does_not_stop_the_others(hass: HomeAssistant, setup) -> None:
    from custom_components.scrypted_mqtt.hub import ScryptedMqttHub

    await start(hass, BASE)
    original = ScryptedMqttHub._async_move

    async def flaky(self, src, dst, platform):
        if src == uid("guard", "person"):
            raise RuntimeError("boom")
        await original(self, src, dst, platform)

    with patch.object(ScryptedMqttHub, "_async_move", flaky):
        fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED, RAW]))
        await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get(RAW_ID).unique_id == uid("bridge", "camera_person")
    # the failed one was left alone and the device was built again
    assert registry.async_get(PRESENCE_ID).unique_id == uid("guard", "person")
    assert hass.states.get("binary_sensor.front_door_motion") is not None


async def test_an_entity_removed_while_being_added_does_not_linger(hass: HomeAssistant, setup) -> None:
    fire(hass, "sources/bridge/status", "online")
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, {"key": "child_9", "name": "Siren", "platform": "switch"}]))
    fire(hass, "devices/42/bridge/config", bridge_config(entities=BASE))
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get_entity_id("switch", DOMAIN, uid("bridge", "child_9")) is None
    assert hass.states.get("switch.front_door_siren") is None
    assert hass.states.get("binary_sensor.front_door_motion") is not None


async def test_replace_cycles_between_bridge_entities_are_ignored(hass: HomeAssistant, setup) -> None:
    a = {"key": "child_1", "name": "A", "platform": "binary_sensor", "replaces": ["bridge:child_2", "bridge:child_1"]}
    b = {"key": "child_2", "name": "B", "platform": "binary_sensor", "replaces": ["bridge:child_1"]}
    await start(hass, [*BASE, a, b])
    registry = er.async_get(hass)
    assert registry.async_get("binary_sensor.front_door_a").unique_id == uid("bridge", "child_1")
    assert registry.async_get("binary_sensor.front_door_b").unique_id == uid("bridge", "child_2")


async def test_a_bridge_that_needs_a_newer_integration_raises_a_repair(hass: HomeAssistant, setup) -> None:
    from homeassistant.helpers import issue_registry as ir

    fire(hass, "sources/bridge/status", "online")
    config = json.loads(bridge_config(entities=BASE))
    fire(hass, "devices/42/bridge/config", json.dumps({**config, "min_integration": "9.0.0"}))
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, "integration_too_old") is not None
    assert hass.states.get("binary_sensor.front_door_motion") is not None  # still works as far as it can
    fire(hass, "devices/42/bridge/config", json.dumps({**config, "min_integration": "0.2.0"}))
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, "integration_too_old") is None


async def test_a_removed_raw_device_hands_its_entry_to_the_derived_entity_and_back(hass: HomeAssistant, setup) -> None:
    derived = {"key": "camera_person", "name": "Camera person", "platform": "binary_sensor", "device_class": "occupancy"}
    child = {"key": "child_31", "name": "Camera person", "platform": "binary_sensor", "device_class": "occupancy", "replaces": ["bridge:camera_person"]}
    await start(hass, [*BASE, derived])
    registry = er.async_get(hass)
    derived_id = registry.async_get_entity_id("binary_sensor", DOMAIN, uid("bridge", "camera_person"))
    registry.async_update_entity(derived_id, labels={"raw"})
    # the camera plugin adds its exact-level child: it takes the entry over
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, child]))
    await hass.async_block_till_done()
    assert registry.async_get(derived_id).unique_id == uid("bridge", "child_31")
    # the child is removed (the derived entity is back): the entry goes with it
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, derived]))
    await hass.async_block_till_done()
    assert (registry.async_get(derived_id).unique_id, registry.async_get(derived_id).labels) == (uid("bridge", "camera_person"), {"raw"})
    # re-added under a new id: it takes it over again
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, {**child, "key": "child_32"}]))
    await hass.async_block_till_done()
    assert (registry.async_get(derived_id).unique_id, registry.async_get(derived_id).labels) == (uid("bridge", "child_32"), {"raw"})
    bridge_prefix = f"{ROOT}:42:bridge:"
    assert len([e for e in registry.entities.values() if e.original_name == "Camera person" and e.unique_id.startswith(bridge_prefix)]) == 1


async def test_a_bridge_entity_waits_while_one_it_replaces_is_being_handed_over(hass: HomeAssistant, setup) -> None:
    from custom_components.scrypted_mqtt.hub import ScryptedMqttHub

    await start(hass, BASE)
    hub: ScryptedMqttHub = setup.runtime_data
    hub._migrating.add(uid("guard", "person"))
    fire(hass, "devices/42/bridge/config", bridge_config(entities=[*BASE, FOLDED]))
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    assert registry.async_get_entity_id("binary_sensor", DOMAIN, uid("bridge", "child_20")) is None
    hub._migrating.clear()
    hub._reconcile("42")
    await hass.async_block_till_done()
    assert registry.async_get(PRESENCE_ID).unique_id == uid("bridge", "child_20")


async def test_the_repair_issue_follows_the_highest_requirement_and_changes_only(hass: HomeAssistant, setup) -> None:
    from homeassistant.helpers import issue_registry as ir

    fire(hass, "sources/bridge/status", "online")
    config = json.loads(bridge_config(entities=BASE))
    issues = ir.async_get(hass)
    with patch.object(ir, "async_create_issue", wraps=ir.async_create_issue) as create:
        fire(hass, "devices/42/bridge/config", json.dumps({**config, "min_integration": "9.0"}))
        fire(hass, "devices/43/bridge/config", json.dumps({**config, "min_integration": "0.2.0"}))
        fire(hass, "devices/42/bridge/config", json.dumps({**config, "min_integration": "9.0.0", "x": 1}))
        await hass.async_block_till_done()
        assert create.call_count == 1  # 9.0 and 9.0.0 are the same requirement
    assert issues.async_get_issue(DOMAIN, "integration_too_old").translation_placeholders["required"] == "9.0"
    fire(hass, "devices/42/bridge/config", "")
    await hass.async_block_till_done()
    assert issues.async_get_issue(DOMAIN, "integration_too_old") is None
