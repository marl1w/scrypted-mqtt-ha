"""The MQTT contract (docs/contract.md): topics and payloads, with no Home Assistant imports."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import re
from typing import Any
from urllib.parse import urlsplit

CONTRACT_VERSION = 1
BRIDGE_SOURCE = "bridge"
PLATFORMS = ("binary_sensor", "sensor", "switch", "button", "event")
MAX_ENTITIES = 64
MAX_STATE = 255

_DEVICE_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
_SOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")
_EVENT_TYPE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_OBJECT_ID_RE = re.compile(r"^[a-z0-9_]{1,128}$")
_REQUEST_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ROOT_RE = re.compile(r"^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$")
_DEVICE_CLASS_RE = re.compile(r"^[a-z_]{1,32}$")
_ICON_RE = re.compile(r"^mdi:[a-z0-9-]{1,64}$")
_STATE_CLASSES = ("measurement", "total", "total_increasing")
_CATEGORIES = ("diagnostic", "config")


class ContractError(ValueError):
    """A payload that does not follow the contract."""


def is_valid_root(root: str) -> bool:
    """Return True for a topic root without wildcards or empty levels."""
    return bool(_ROOT_RE.match(root))


def is_event_type(value: Any) -> bool:
    """Return True for a valid event type."""
    return isinstance(value, str) and bool(_EVENT_TYPE_RE.match(value))


@dataclass(frozen=True)
class EntitySpec:
    """One entity as a source declares it."""

    key: str
    name: str
    platform: str
    device_class: str | None = None
    unit: str | None = None
    state_class: str | None = None
    event_types: tuple[str, ...] = ()
    category: str | None = None
    enabled: bool = True
    icon: str | None = None
    object_id: str | None = None


@dataclass(frozen=True)
class StreamSpec:
    """A further stream of the device (one more camera entity)."""

    key: str
    name: str
    url: str


MAX_STREAMS = 4


@dataclass(frozen=True)
class DeviceSpec:
    """The device as the bridge describes it."""

    name: str
    model: str | None = None
    manufacturer: str | None = None
    sw_version: str | None = None
    stream: str | None = None
    streams: tuple[StreamSpec, ...] = ()


@dataclass(frozen=True)
class Config:
    """A source's config for one device."""

    device: DeviceSpec | None
    entities: tuple[EntitySpec, ...]
    errors: tuple[str, ...] = field(default=(), compare=False)


def _text(value: Any, limit: int = 255) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= limit:
        return value
    return None


def parse_entity(raw: Any) -> EntitySpec:
    """Return the entity, or raise ContractError with the reason."""
    if not isinstance(raw, dict):
        raise ContractError("entity is not an object")
    key = raw.get("key")
    if not isinstance(key, str) or not _KEY_RE.match(key):
        raise ContractError(f"invalid key {key!r}")
    name = _text(raw.get("name"), 64)
    if name is None:
        raise ContractError(f"{key}: invalid name")
    platform = raw.get("platform")
    if platform not in PLATFORMS:
        raise ContractError(f"{key}: invalid platform")
    values: dict[str, Any] = {}
    if (device_class := raw.get("device_class")) is not None:
        if not isinstance(device_class, str) or not _DEVICE_CLASS_RE.match(device_class):
            raise ContractError(f"{key}: invalid device_class")
        values["device_class"] = device_class
    if (unit := raw.get("unit")) is not None:
        if platform != "sensor" or _text(unit, 16) is None:
            raise ContractError(f"{key}: invalid unit")
        values["unit"] = unit
    if (state_class := raw.get("state_class")) is not None:
        if platform != "sensor" or state_class not in _STATE_CLASSES:
            raise ContractError(f"{key}: invalid state_class")
        values["state_class"] = state_class
    if (event_types := raw.get("event_types")) is not None:
        if (
            platform != "event"
            or not isinstance(event_types, list)
            or len(event_types) > 64
            or not all(is_event_type(t) for t in event_types)
        ):
            raise ContractError(f"{key}: invalid event_types")
        values["event_types"] = tuple(dict.fromkeys(event_types))
    if (category := raw.get("category")) is not None:
        if category not in _CATEGORIES:
            raise ContractError(f"{key}: invalid category")
        values["category"] = category
    if (enabled := raw.get("enabled")) is not None:
        if not isinstance(enabled, bool):
            raise ContractError(f"{key}: invalid enabled")
        values["enabled"] = enabled
    if (icon := raw.get("icon")) is not None:
        if not isinstance(icon, str) or not _ICON_RE.match(icon):
            raise ContractError(f"{key}: invalid icon")
        values["icon"] = icon
    if (object_id := raw.get("object_id")) is not None:
        if not isinstance(object_id, str) or not _OBJECT_ID_RE.match(object_id):
            raise ContractError(f"{key}: invalid object_id")
        values["object_id"] = object_id
    return EntitySpec(key=key, name=name, platform=platform, **values)


def _parse_stream(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("rtsp", "rtsps") or not parts.hostname:
        return None
    return value


def _parse_streams(raw: Any) -> tuple[StreamSpec, ...]:
    if not isinstance(raw, list):
        return ()
    out: dict[str, StreamSpec] = {}
    for item in raw[:MAX_STREAMS]:
        if not isinstance(item, dict):
            continue
        key, name, url = item.get("key"), _text(item.get("name"), 64), _parse_stream(item.get("url"))
        if isinstance(key, str) and _KEY_RE.match(key) and name and url and key not in out:
            out[key] = StreamSpec(key=key, name=name, url=url)
    return tuple(out.values())


def parse_config(payload: bytes, source: str) -> Config:
    """Return the config; invalid entities are left out and listed in errors."""
    try:
        data = json.loads(payload)
    except ValueError as err:
        raise ContractError("config is not JSON") from err
    if not isinstance(data, dict):
        raise ContractError("config is not an object")
    if data.get("v") != CONTRACT_VERSION:
        raise ContractError(f"unsupported contract version {data.get('v')!r}")
    device: DeviceSpec | None = None
    if source == BRIDGE_SOURCE:
        raw = data.get("device")
        if not isinstance(raw, dict) or _text(raw.get("name")) is None:
            raise ContractError("bridge config without a device name")
        device = DeviceSpec(
            name=raw["name"],
            model=_text(raw.get("model")),
            manufacturer=_text(raw.get("manufacturer")),
            sw_version=_text(raw.get("sw_version")),
            stream=_parse_stream(raw.get("stream")),
            streams=_parse_streams(raw.get("streams")),
        )
    raw_entities = data.get("entities")
    if not isinstance(raw_entities, list):
        raise ContractError("entities is not a list")
    entities: list[EntitySpec] = []
    errors: list[str] = []
    keys: set[str] = set()
    for raw in raw_entities[:MAX_ENTITIES]:
        try:
            spec = parse_entity(raw)
        except ContractError as err:
            errors.append(str(err))
            continue
        if spec.key in keys:
            errors.append(f"duplicate key {spec.key}")
            continue
        keys.add(spec.key)
        entities.append(spec)
    if len(raw_entities) > MAX_ENTITIES:
        errors.append(f"more than {MAX_ENTITIES} entities, the rest ignored")
    return Config(device=device, entities=tuple(entities), errors=tuple(errors))


def parse_event(payload: bytes) -> tuple[str, dict[str, Any]]:
    """Return the event type and its attributes."""
    try:
        data = json.loads(payload)
    except ValueError as err:
        raise ContractError("event is not JSON") from err
    if not isinstance(data, dict) or not is_event_type(data.get("event_type")):
        raise ContractError("invalid event_type")
    attributes = data.get("attributes")
    return data["event_type"], attributes if isinstance(attributes, dict) else {}


def parse_state(payload: bytes) -> str | None:
    """Return the state text, None for unknown."""
    if not payload or len(payload) > MAX_STATE:
        return None
    try:
        return payload.decode()
    except UnicodeDecodeError:
        return None


@dataclass(frozen=True)
class Topic:
    """An inbound topic the integration acts on."""

    kind: str  # status, config, state, event, snapshot
    source: str | None = None
    device: str | None = None
    key: str | None = None  # entity key, or the request id of a snapshot


def parse_topic(root: str, topic: str) -> Topic | None:
    """Return what a topic under root is, or None for anything the integration ignores."""
    if not topic.startswith(root + "/"):
        return None
    parts = topic[len(root) + 1 :].split("/")
    if len(parts) == 3 and parts[0] == "sources" and parts[2] == "status":
        return Topic("status", source=parts[1]) if _SOURCE_RE.match(parts[1]) else None
    if len(parts) < 4 or parts[0] != "devices":
        return None
    device, source = parts[1], parts[2]
    if not _DEVICE_RE.match(device) or not _SOURCE_RE.match(source):
        return None
    if len(parts) == 4 and parts[3] == "config":
        return Topic("config", source=source, device=device)
    if len(parts) == 5 and parts[3] in ("state", "event") and _KEY_RE.match(parts[4]):
        return Topic(parts[3], source=source, device=device, key=parts[4])
    if (
        len(parts) == 5
        and source == BRIDGE_SOURCE
        and parts[3] == "snapshot"
        and parts[4] != "request"
        and _REQUEST_RE.match(parts[4])
    ):
        return Topic("snapshot", source=source, device=device, key=parts[4])
    return None
