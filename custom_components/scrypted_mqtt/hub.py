"""Builds devices and entities from the Scrypted MQTT topics."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import json
import logging
import secrets
from typing import TYPE_CHECKING, Any

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, SNAPSHOT_TIMEOUT, STALE_GRACE
from .contract import (
    BRIDGE_SOURCE,
    Config,
    ContractError,
    DeviceSpec,
    EntitySpec,
    parse_config,
    parse_event,
    parse_state,
    parse_topic,
)

if TYPE_CHECKING:
    from .entity import ScryptedMqttEntity

_LOGGER = logging.getLogger(__name__)

CAMERA_KEY = "camera"
CAMERA_PLATFORM = "camera"

# Anything bigger is not something the bridge or an add-on sends: dropped before parsing.
MAX_CONFIG_BYTES = 65536
MAX_EVENT_BYTES = 4096
MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
# Bounds on what a publisher on the broker can make the hub remember.
MAX_STATES = 20000
MAX_DEVICES = 512
MAX_SOURCES_PER_DEVICE = 16
MAX_WARNINGS = 256
# Snapshot widths are rounded up to these, so dashboards of different sizes share one picture.
SNAPSHOT_WIDTHS = (320, 640, 1280, 1920)

type EntityFactory = Callable[["ScryptedMqttHub", str, str, EntitySpec | None], Entity]


class ScryptedMqttHub:
    """All state received for one topic root, and the entities built from it."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, root: str) -> None:
        """Initialize the hub."""
        self.hass = hass
        self.entry = entry
        self.root = root
        self._bridge: dict[str, Config] = {}
        self._sources: dict[str, dict[str, Config]] = {}
        self._states: dict[tuple[str, str, str], str | None] = {}
        self._status: dict[str, bool] = {}
        # unique id -> (platform, device, source, spec) of every entity handed to a platform
        self._created: dict[str, tuple[str, str, str, EntitySpec | None]] = {}
        self._entities: dict[str, ScryptedMqttEntity] = {}
        self._platforms: dict[str, tuple[AddEntitiesCallback, EntityFactory]] = {}
        self._snapshots: dict[str, tuple[str, asyncio.Future[bytes | None]]] = {}
        self._inflight: dict[tuple[str, int | None, int | None], asyncio.Future[bytes | None]] = {}
        self._warned: set[str] = set()
        self._unsubscribe: CALLBACK_TYPE | None = None
        self._stale_timer: CALLBACK_TYPE | None = None
        self._stale_done = False
        self._unsubscribe_connection: CALLBACK_TYPE | None = None

    # ---- identifiers -----------------------------------------------------------------------

    def unique_id(self, device: str, source: str, key: str) -> str:
        """Return the unique id of an entity."""
        if source == BRIDGE_SOURCE and key == CAMERA_KEY:
            return f"{self.root}:{device}:{CAMERA_KEY}"
        return f"{self.root}:{device}:{source}:{key}"

    def device_identifier(self, device: str) -> tuple[str, str]:
        """Return the device registry identifier of a Scrypted device."""
        return (DOMAIN, f"{self.root}:{device}")

    def _parse_unique_id(self, unique_id: str) -> tuple[str, str, str] | None:
        if not unique_id.startswith(self.root + ":"):
            return None
        parts = unique_id[len(self.root) + 1 :].split(":")
        if len(parts) == 2 and parts[1] == CAMERA_KEY:
            return parts[0], BRIDGE_SOURCE, CAMERA_KEY
        if len(parts) == 3:
            return parts[0], parts[1], parts[2]
        return None

    # ---- lifecycle -------------------------------------------------------------------------

    @callback
    def register_platform(self, platform: str, add: AddEntitiesCallback, factory: EntityFactory) -> None:
        """Register how a platform creates and adds its entities."""
        self._platforms[platform] = (add, factory)

    async def async_start(self) -> None:
        """Subscribe to the root; retained topics arrive at once."""
        self._unsubscribe = await mqtt.async_subscribe(self.hass, f"{self.root}/#", self._on_message, qos=1, encoding=None)
        self._unsubscribe_connection = mqtt.async_subscribe_connection_status(self.hass, self._on_connection)
        self._schedule_stale_check(STALE_GRACE)

    @callback
    def _on_connection(self, connected: bool) -> None:
        # removals made while disconnected are never redelivered: check for stale devices again once reconnected
        if connected and self._stale_done:
            self._stale_done = False
            self._schedule_stale_check(STALE_GRACE)

    @callback
    def async_stop(self) -> None:
        """Unsubscribe and fail pending snapshots."""
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        if self._stale_timer:
            self._stale_timer()
            self._stale_timer = None
        if self._unsubscribe_connection:
            self._unsubscribe_connection()
            self._unsubscribe_connection = None
        for _, fut in self._snapshots.values():
            if not fut.done():
                fut.set_result(None)
        self._snapshots.clear()
        self._inflight.clear()

    @callback
    def attach(self, unique_id: str, entity: ScryptedMqttEntity) -> None:
        """Track a live entity so updates reach it."""
        self._entities[unique_id] = entity

    @callback
    def detach(self, unique_id: str, entity: ScryptedMqttEntity) -> None:
        """Forget a removed entity."""
        if self._entities.get(unique_id) is entity:
            del self._entities[unique_id]

    # ---- reads for entities ----------------------------------------------------------------

    def is_available(self, device: str, source: str) -> bool:
        """Return True when the bridge, the device and the entity's source are all there."""
        if not self._status.get(BRIDGE_SOURCE) or device not in self._bridge:
            return False
        return source == BRIDGE_SOURCE or self._status.get(source, True)

    def state(self, device: str, source: str, key: str) -> str | None:
        """Return the last state of an entity, None when unknown."""
        return self._states.get((device, source, key))

    def device_spec(self, device: str) -> DeviceSpec | None:
        """Return the bridge's description of a device."""
        cfg = self._bridge.get(device)
        return cfg.device if cfg else None

    # ---- MQTT ------------------------------------------------------------------------------

    @callback
    def _on_message(self, msg: mqtt.ReceiveMessage) -> None:
        topic = parse_topic(self.root, msg.topic)
        if topic is None:
            return
        payload: bytes = msg.payload if isinstance(msg.payload, bytes) else str(msg.payload).encode()
        try:
            if topic.kind == "status":
                self._on_status(topic.source, payload)
            elif topic.kind == "config":
                self._on_config(topic.device, topic.source, payload)
            elif topic.kind == "state":
                self._on_state(topic.device, topic.source, topic.key, payload)
            elif topic.kind == "event":
                self._on_event(topic.device, topic.source, topic.key, payload)
            elif topic.kind == "snapshot":
                pending = self._snapshots.get(topic.key)
                if pending and pending[0] == topic.device and not pending[1].done():
                    pending[1].set_result(payload if 0 < len(payload) <= MAX_SNAPSHOT_BYTES else None)
        except ContractError as err:
            self._warn_once(msg.topic, f"{msg.topic}: {err}")

    def _warn_once(self, key: str, message: str) -> None:
        if key in self._warned or len(self._warned) >= MAX_WARNINGS:
            _LOGGER.debug(message)
            return
        self._warned.add(key)
        _LOGGER.warning(message)

    @callback
    def _on_status(self, source: str, payload: bytes) -> None:
        online = payload == b"online"
        if self._status.get(source) == online:
            return
        self._status[source] = online
        for unique_id, (_, _, src, _) in self._created.items():
            if (source == BRIDGE_SOURCE or src == source) and (entity := self._entities.get(unique_id)):
                entity.handle_update()

    @callback
    def _on_config(self, device: str, source: str, payload: bytes) -> None:
        if not payload:
            if source == BRIDGE_SOURCE:
                self._bridge.pop(device, None)
                self._remove_device(device)
            elif self._sources.get(device, {}).pop(source, None) is not None:
                self._reconcile(device)
            return
        if len(payload) > MAX_CONFIG_BYTES:
            raise ContractError("config larger than 64 KB")
        if source == BRIDGE_SOURCE:
            if device not in self._bridge and len(self._bridge) >= MAX_DEVICES:
                raise ContractError("too many devices")
        else:
            sources = self._sources.get(device, {})
            if source not in sources and (len(sources) >= MAX_SOURCES_PER_DEVICE or (not sources and len(self._sources) >= MAX_DEVICES)):
                raise ContractError("too many sources")
        config = parse_config(payload, source)
        for error in config.errors:
            self._warn_once(f"{device}/{source}/{error}", f"{device}/{source}: {error}")
        if source == BRIDGE_SOURCE:
            if self._bridge.get(device) == config:
                return
            self._bridge[device] = config
            self._register_device(device, config)
        else:
            if self._sources.get(device, {}).get(source) == config:
                return
            self._sources.setdefault(device, {})[source] = config
        self._reconcile(device)

    @callback
    def _on_state(self, device: str, source: str, key: str, payload: bytes) -> None:
        state_key = (device, source, key)
        if state_key not in self._states and len(self._states) >= MAX_STATES:
            raise ContractError("too many states")
        self._states[state_key] = parse_state(payload)
        if entity := self._entities.get(self.unique_id(device, source, key)):
            entity.handle_update()

    @callback
    def _on_event(self, device: str, source: str, key: str, payload: bytes) -> None:
        entity = self._entities.get(self.unique_id(device, source, key))
        if entity is None or not hasattr(entity, "fire"):
            return
        if len(payload) > MAX_EVENT_BYTES:
            raise ContractError("event larger than 4 KB")
        event_type, attributes = parse_event(payload)
        entity.fire(event_type, attributes)

    # ---- devices and entities --------------------------------------------------------------

    @callback
    def _register_device(self, device: str, config: Config) -> None:
        spec = config.device
        dr.async_get(self.hass).async_get_or_create(
            config_entry_id=self.entry.entry_id,
            identifiers={self.device_identifier(device)},
            name=spec.name,
            model=spec.model,
            manufacturer=spec.manufacturer,
            sw_version=spec.sw_version,
        )
        if entity := self._entities.get(self.unique_id(device, BRIDGE_SOURCE, CAMERA_KEY)):
            entity.handle_update()

    def _desired(self, device: str) -> dict[str, tuple[str, str, EntitySpec | None]]:
        bridge = self._bridge.get(device)
        if bridge is None:
            return {}
        desired: dict[str, tuple[str, str, EntitySpec | None]] = {
            self.unique_id(device, BRIDGE_SOURCE, CAMERA_KEY): (CAMERA_PLATFORM, BRIDGE_SOURCE, None)
        }
        configs = [(BRIDGE_SOURCE, bridge), *self._sources.get(device, {}).items()]
        for source, config in configs:
            for spec in config.entities:
                if source == BRIDGE_SOURCE and spec.key == CAMERA_KEY:
                    continue
                desired[self.unique_id(device, source, spec.key)] = (spec.platform, source, spec)
        return desired

    @callback
    def _reconcile(self, device: str) -> None:
        """Make the device's entities match what its sources declare."""
        desired = self._desired(device)
        current = {uid: v for uid, v in self._created.items() if v[1] == device}
        for uid, (platform, _, _, _) in current.items():
            if uid not in desired or desired[uid][0] != platform:
                self._remove_entity(uid, platform)
        to_add: dict[str, list[Entity]] = {}
        for uid, (platform, source, spec) in desired.items():
            known = self._created.get(uid)
            if known is not None:
                if known[3] != spec:
                    self._created[uid] = (platform, device, source, spec)
                    if (entity := self._entities.get(uid)) and spec is not None:
                        entity.update_spec(spec)
                continue
            if platform not in self._platforms:
                continue
            self._created[uid] = (platform, device, source, spec)
            to_add.setdefault(platform, []).append(self._platforms[platform][1](self, device, source, spec))
        for platform, entities in to_add.items():
            self._platforms[platform][0](entities)
        # entities of this device that a source with a config no longer declares (also while Home Assistant was down)
        declared_sources = {BRIDGE_SOURCE, *self._sources.get(device, {})} if device in self._bridge else set()
        self._prune_registry(lambda d, s: d == device and s in declared_sources, desired)

    @callback
    def _remove_entity(self, unique_id: str, platform: str) -> None:
        self._created.pop(unique_id, None)
        registry = er.async_get(self.hass)
        if entity_id := registry.async_get_entity_id(platform, DOMAIN, unique_id):
            registry.async_remove(entity_id)
        elif entity := self._entities.get(unique_id):
            self.hass.async_create_task(entity.async_remove(force_remove=True))

    @callback
    def _prune_registry(self, match: Callable[[str, str], bool], keep: dict[str, Any]) -> None:
        registry = er.async_get(self.hass)
        for entry in er.async_entries_for_config_entry(registry, self.entry.entry_id):
            parsed = self._parse_unique_id(entry.unique_id)
            if parsed is None or entry.unique_id in keep:
                continue
            if match(parsed[0], parsed[1]):
                self._created.pop(entry.unique_id, None)
                registry.async_remove(entry.entity_id)

    @callback
    def _remove_device(self, device: str) -> None:
        for uid, (platform, dev, _, _) in list(self._created.items()):
            if dev == device:
                self._remove_entity(uid, platform)
        self._prune_registry(lambda d, _s: d == device, {})
        registry = dr.async_get(self.hass)
        if entry := registry.async_get_device(identifiers={self.device_identifier(device)}):
            registry.async_update_device(entry.id, remove_config_entry_id=self.entry.entry_id)

    # ---- stale devices ---------------------------------------------------------------------

    @callback
    def _schedule_stale_check(self, delay: float) -> None:
        self._stale_timer = async_call_later(self.hass, delay, self._stale_check)

    @callback
    def _stale_check(self, _now: Any) -> None:
        """Once the bridge is online and has republished, drop what nothing declares any more."""
        self._stale_timer = None
        if self._stale_done:
            return
        if not self._status.get(BRIDGE_SOURCE):
            self._schedule_stale_check(60)
            return
        self._stale_done = True
        registry = dr.async_get(self.hass)
        for entry in dr.async_entries_for_config_entry(registry, self.entry.entry_id):
            for domain, identifier in entry.identifiers:
                if domain != DOMAIN or not identifier.startswith(self.root + ":"):
                    continue
                device = identifier[len(self.root) + 1 :]
                if device not in self._bridge:
                    _LOGGER.info("Removing %s: no longer published", entry.name)
                    self._remove_device(device)
        keep: dict[str, Any] = {}
        for device in self._bridge:
            keep.update(self._desired(device))
        self._prune_registry(lambda _d, _s: True, keep)

    # ---- outbound --------------------------------------------------------------------------

    async def async_command(self, device: str, source: str, key: str, value: str) -> None:
        """Ask a source to switch or press one of its entities."""
        await mqtt.async_publish(
            self.hass, f"{self.root}/devices/{device}/{source}/set/{key}", value, qos=1, retain=False
        )

    async def async_snapshot(self, device: str, width: int | None, height: int | None) -> bytes | None:
        """Return a JPEG from the bridge, None when none arrives in time."""
        if width:
            width = next((w for w in SNAPSHOT_WIDTHS if w >= width), None)
            height = None
        key = (device, width, height)
        if (pending := self._inflight.get(key)) is not None:
            return await self._wait(pending)
        request_id = secrets.token_hex(8)
        fut: asyncio.Future[bytes | None] = self.hass.loop.create_future()
        self._snapshots[request_id] = (device, fut)
        self._inflight[key] = fut
        try:
            request: dict[str, Any] = {"id": request_id}
            if width:
                request["width"] = width
            if height:
                request["height"] = height
            await mqtt.async_publish(
                self.hass,
                f"{self.root}/devices/{device}/{BRIDGE_SOURCE}/snapshot/request",
                json.dumps(request),
                qos=0,
                retain=False,
            )
            return await self._wait(fut)
        finally:
            self._snapshots.pop(request_id, None)
            if self._inflight.get(key) is fut:
                del self._inflight[key]

    @staticmethod
    async def _wait(fut: asyncio.Future[bytes | None]) -> bytes | None:
        try:
            return await asyncio.wait_for(asyncio.shield(fut), SNAPSHOT_TIMEOUT)
        except TimeoutError:
            return None
