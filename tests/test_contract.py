"""Tests for the contract module (no Home Assistant needed)."""

import json

import pytest

from custom_components.scrypted_mqtt.contract import (
    ContractError,
    Topic,
    is_valid_root,
    parse_config,
    parse_event,
    parse_state,
    parse_topic,
)


def _config(**extra) -> bytes:
    data = {"v": 1, "entities": [{"key": "motion", "name": "Motion", "platform": "binary_sensor"}], **extra}
    return json.dumps(data).encode()


def test_bridge_config_needs_a_device_and_keeps_only_rtsp_streams() -> None:
    cfg = parse_config(_config(device={"name": "Front door", "stream": "rtsp://127.0.0.1:1/x"}), "bridge")
    assert cfg.device.name == "Front door"
    assert cfg.device.stream == "rtsp://127.0.0.1:1/x"
    assert parse_config(_config(device={"name": "x", "stream": "http://a/b"}), "bridge").device.stream is None
    with pytest.raises(ContractError):
        parse_config(_config(), "bridge")


def test_add_on_configs_ignore_a_device_block() -> None:
    assert parse_config(_config(device={"name": "x"}), "guard").device is None


def test_invalid_entities_are_left_out_with_a_reason() -> None:
    payload = json.dumps(
        {
            "v": 1,
            "entities": [
                {"key": "ok", "name": "Ok", "platform": "sensor", "unit": "%"},
                {"key": "ok", "name": "Dup", "platform": "sensor"},
                {"key": "Bad", "name": "x", "platform": "sensor"},
                {"key": "u", "name": "x", "platform": "binary_sensor", "unit": "%"},
            ],
        }
    ).encode()
    cfg = parse_config(payload, "guard")
    assert [e.key for e in cfg.entities] == ["ok"]
    assert len(cfg.errors) == 3


def test_unknown_versions_and_garbage_are_refused() -> None:
    with pytest.raises(ContractError):
        parse_config(json.dumps({"v": 2, "entities": []}).encode(), "guard")
    with pytest.raises(ContractError):
        parse_config(b"nope", "guard")


def test_configs_compare_equal_when_unchanged() -> None:
    assert parse_config(_config(), "guard") == parse_config(_config(), "guard")


def test_topics() -> None:
    assert parse_topic("scrypted", "scrypted/sources/bridge/status") == Topic("status", source="bridge")
    assert parse_topic("scrypted", "scrypted/devices/42/bridge/config") == Topic("config", source="bridge", device="42")
    assert parse_topic("scrypted", "scrypted/devices/42/guard/state/person") == Topic(
        "state", source="guard", device="42", key="person"
    )
    assert parse_topic("scrypted", "scrypted/devices/42/bridge/snapshot/ab12") == Topic(
        "snapshot", source="bridge", device="42", key="ab12"
    )
    assert parse_topic("scrypted", "scrypted/devices/42/bridge/snapshot/request") is None
    assert parse_topic("scrypted", "scrypted/devices/42/guard/set/person") is None
    assert parse_topic("scrypted", "other/devices/42/bridge/config") is None
    assert parse_topic("scrypted", "scrypted/devices/4.2/bridge/config") is None


def test_events_states_and_roots() -> None:
    assert parse_event(b'{"event_type":"person","attributes":{"score":1}}') == ("person", {"score": 1})
    assert parse_event(b'{"event_type":"person","attributes":[1]}') == ("person", {})
    with pytest.raises(ContractError):
        parse_event(b'{"event_type":"Bad Type"}')
    assert parse_state(b"ON") == "ON"
    assert parse_state(b"") is None
    assert parse_state(b"x" * 300) is None
    assert is_valid_root("scrypted")
    assert is_valid_root("home/scrypted")
    assert not is_valid_root("scrypted/#")
    assert not is_valid_root("")
