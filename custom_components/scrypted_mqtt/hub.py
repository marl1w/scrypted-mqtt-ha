"""Builds devices and entities from the Scrypted MQTT topics."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime
import hashlib
import json
import logging
import re
import secrets
from typing import TYPE_CHECKING, Any, NamedTuple

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er, issue_registry as ir
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SNAPSHOT_TIMEOUT, STALE_GRACE, VERSION
from .contract import (
    BRIDGE_SOURCE,
    Config,
    ContractError,
    DeviceSpec,
    EntitySpec,
    parse_config,
    parse_event,
    parse_image,
    parse_state,
    parse_topic,
    version_tuple,
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
MAX_IMAGE_BYTES_TOTAL = 64 * 1024 * 1024
MAX_IMAGES = 1024
# Every image is charged at least this much against MAX_IMAGE_BYTES_TOTAL, so tiny ones cannot add up unbounded.
MIN_IMAGE_COST = 4096
# Images that arrived before a config declaring them (retained topics come in any order); the oldest goes first.
MAX_PENDING_IMAGES = 32
MAX_DEVICES = 512
MAX_SOURCES_PER_DEVICE = 16
MAX_WARNINGS = 256
# Snapshot widths are rounded up to these, so dashboards of different sizes share one picture.
SNAPSHOT_WIDTHS = (320, 640, 1280, 1920)

type EntityFactory = Callable[["ScryptedMqttHub", str, str, EntitySpec | None], Entity]


class StoredImage(NamedTuple):
    """An image as received: its bytes, their SHA-256 and when it arrived."""

    content: bytes
    digest: str
    received: datetime


_SUFFIX_RE = re.compile(r"_\d+$")


def _keep_rank(entry: er.RegistryEntry) -> tuple[bool, bool, float]:
    """Rank two registry entries of one entity: customised first, then without a `_2` suffix, then older."""
    customised = bool(
        entry.area_id
        or entry.labels
        or entry.name
        or entry.icon
        or entry.disabled_by == er.RegistryEntryDisabler.USER
        or entry.hidden_by == er.RegistryEntryHider.USER
    )
    unsuffixed = not _SUFFIX_RE.search(entry.entity_id.split(".", 1)[1])
    return customised, unsuffixed, -entry.created_at.timestamp()


def _image_cost(content: bytes) -> int:
    return max(len(content), MIN_IMAGE_COST)


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
        self._images: dict[tuple[str, str, str], StoredImage] = {}
        self._image_bytes = 0
        self._pending_images: dict[tuple[str, str, str], bytes] = {}
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
        # unique ids whose registry entry is being handed over (section 9), and so neither created nor removed meanwhile
        self._migrating: set[str] = set()
        # entities handed to a platform that have not been added yet, and those of them no longer wanted
        self._adding: dict[str, Entity] = {}
        # the integration version each device's bridge config asks for, and the one a repair issue is raised for
        self._required: dict[str, str] = {}
        self._issue_for: str | None = None
        # hand-overs that failed: not tried again, and both unique ids left as they are, until Home Assistant restarts
        self._failed_moves: set[tuple[str, str]] = set()
        self._cancelled: list[Entity] = []

    # ---- identifiers -----------------------------------------------------------------------

    def unique_id(self, device: str, source: str, key: str) -> str:
        """Return the unique id of an entity."""
        if source == BRIDGE_SOURCE and key == CAMERA_KEY:
            return f"{self.root}:{device}:{CAMERA_KEY}"
        return f"{self.root}:{device}:{source}:{key}"

    def camera_unique_id(self, device: str, stream: str | None) -> str:
        """Return the unique id of the device's camera, or of one of its extra streams."""
        base = self.unique_id(device, BRIDGE_SOURCE, CAMERA_KEY)
        return f"{base}:{stream}" if stream else base

    def device_identifier(self, device: str) -> tuple[str, str]:
        """Return the device registry identifier of a Scrypted device."""
        return (DOMAIN, f"{self.root}:{device}")

    def _parse_unique_id(self, unique_id: str) -> tuple[str, str, str] | None:
        if not unique_id.startswith(self.root + ":"):
            return None
        parts = unique_id[len(self.root) + 1 :].split(":")
        if len(parts) == 2 and parts[1] == CAMERA_KEY:
            return parts[0], BRIDGE_SOURCE, CAMERA_KEY
        if len(parts) == 3 and parts[1] == CAMERA_KEY:
            return parts[0], BRIDGE_SOURCE, f"{CAMERA_KEY}:{parts[2]}"
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
        """Track a live entity so updates reach it; one removed while it was being added goes again at once."""
        if self._adding.get(unique_id) is entity:
            del self._adding[unique_id]
        if any(e is entity for e in self._cancelled):
            self._cancelled = [e for e in self._cancelled if e is not entity]
            self.hass.async_create_task(self._async_drop_cancelled(unique_id, entity), eager_start=False)
            return
        self._entities[unique_id] = entity

    async def _async_drop_cancelled(self, unique_id: str, entity: ScryptedMqttEntity) -> None:
        registry = er.async_get(self.hass)
        if unique_id not in self._created and unique_id not in self._migrating and entity.entity_id and registry.async_get(entity.entity_id):
            registry.async_remove(entity.entity_id)
        else:
            await entity.async_remove(force_remove=True)

    @callback
    def _cancel_pending(self, unique_id: str) -> None:
        if (pending := self._adding.pop(unique_id, None)) is not None:
            self._cancelled.append(pending)

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

    def image(self, device: str, source: str, key: str) -> StoredImage | None:
        """Return the last image of an entity, None when there is none."""
        return self._images.get((device, source, key))

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
            elif topic.kind == "image":
                self._on_image(topic.device, topic.source, topic.key, payload)
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
                self._require(device, None)
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
            self._require(device, config.min_integration)
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
    def _require(self, device: str, required: str | None) -> None:
        """Note the version a device's bridge config asks for; raise or clear the repair issue when that changes."""
        if required:
            self._required[device] = required
        else:
            self._required.pop(device, None)
        highest = max(self._required.values(), key=version_tuple, default=None)
        too_old = highest if highest and version_tuple(highest) > version_tuple(VERSION) else None
        if (too_old and version_tuple(too_old)) == (self._issue_for and version_tuple(self._issue_for)):
            return
        self._issue_for = too_old
        if too_old is None:
            ir.async_delete_issue(self.hass, DOMAIN, "integration_too_old")
            return
        _LOGGER.warning("The Scrypted MQTT bridge needs integration %s or newer; this is %s", too_old, VERSION)
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            "integration_too_old",
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key="integration_too_old",
            translation_placeholders={"required": too_old, "current": VERSION},
        )

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

    def _declares_image(self, device: str, source: str, key: str) -> bool:
        config = self._bridge.get(device) if source == BRIDGE_SOURCE else self._sources.get(device, {}).get(source)
        return config is not None and any(e.key == key and e.platform == "image" for e in config.entities)

    @callback
    def _on_image(self, device: str, source: str, key: str, payload: bytes) -> None:
        image_key = (device, source, key)
        jpeg = parse_image(payload)
        if self._declares_image(device, source, key):
            self._store_image(image_key, jpeg)
            return
        # only declared images are kept; one may arrive just before its config, so a few wait for it
        self._pending_images.pop(image_key, None)
        if jpeg is not None:
            self._pending_images[image_key] = jpeg
            while len(self._pending_images) > MAX_PENDING_IMAGES:
                del self._pending_images[next(iter(self._pending_images))]

    @callback
    def _store_image(self, image_key: tuple[str, str, str], jpeg: bytes | None) -> None:
        before = self._images.get(image_key)
        if jpeg is not None:
            if before is not None and before.content == jpeg:
                return
            if before is None and len(self._images) >= MAX_IMAGES:
                raise ContractError(f"more than {MAX_IMAGES} images")
            if self._image_bytes - (_image_cost(before.content) if before else 0) + _image_cost(jpeg) > MAX_IMAGE_BYTES_TOTAL:
                raise ContractError("more than 64 MB of images")
        self._forget_image(image_key)
        if jpeg is not None:
            self._images[image_key] = StoredImage(jpeg, hashlib.sha256(jpeg).hexdigest(), dt_util.utcnow())
            self._image_bytes += _image_cost(jpeg)
        if entity := self._entities.get(self.unique_id(*image_key)):
            if jpeg is None and hasattr(entity, "clear_image"):
                entity.clear_image()
            else:
                entity.handle_update()

    @callback
    def _forget_image(self, image_key: tuple[str, str, str]) -> None:
        if (before := self._images.pop(image_key, None)) is not None:
            self._image_bytes -= _image_cost(before.content)

    @callback
    def _reconcile_images(self, device: str) -> None:
        """Drop the device's images no config declares any more, and take those that arrived before their config."""
        for image_key in [k for k in self._images if k[0] == device and not self._declares_image(*k)]:
            self._forget_image(image_key)
        for image_key in [k for k in self._pending_images if k[0] == device and self._declares_image(*k)]:
            jpeg = self._pending_images.pop(image_key)
            try:
                self._store_image(image_key, jpeg)
            except ContractError as err:
                self._warn_once("/".join(image_key), f"{'/'.join(image_key)}: {err}")

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
        for uid, (platform, dev, _, _) in self._created.items():
            if dev == device and platform == CAMERA_PLATFORM and (entity := self._entities.get(uid)):
                entity.handle_update()

    def _desired(self, device: str) -> dict[str, tuple[str, str, EntitySpec | None]]:
        bridge = self._bridge.get(device)
        if bridge is None:
            return {}
        desired: dict[str, tuple[str, str, EntitySpec | None]] = {
            self.unique_id(device, BRIDGE_SOURCE, CAMERA_KEY): (CAMERA_PLATFORM, BRIDGE_SOURCE, None)
        }
        for stream in bridge.device.streams if bridge.device else ():
            # an extra camera: its spec carries the stream key and name
            desired[self.camera_unique_id(device, stream.key)] = (
                CAMERA_PLATFORM,
                BRIDGE_SOURCE,
                EntitySpec(key=stream.key, name=stream.name, platform=CAMERA_PLATFORM),
            )
        # the bridge's entity wins over an add-on entity it replaces: the add-on's is not created
        replaced = {r for spec in bridge.entities for r in spec.replaces}
        configs = [(BRIDGE_SOURCE, bridge), *self._sources.get(device, {}).items()]
        for source, config in configs:
            for spec in config.entities:
                if source == BRIDGE_SOURCE and spec.key == CAMERA_KEY:
                    continue
                if (source, spec.key) in replaced:
                    continue
                desired[self.unique_id(device, source, spec.key)] = (spec.platform, source, spec)
        return desired

    def _moves(self, device: str, desired: dict[str, tuple[str, str, EntitySpec | None]]) -> tuple[list[tuple[str, str, str]], set[str]]:
        """Return the registry entries to hand over (section 9) as (from, to, platform), and unique ids to hold back.

        - Forward: an entity a bridge entity replaces, still registered, goes to the bridge's. While one it replaces is
          being handed over already, the bridge's is held back for this pass rather than created beside it.
        - Leaving: a bridge entity that is no longer wanted hands its entry to an entity its last `replaces` named that
          is wanted now and has no entry (a raw-signal device removed, then its derived or add-on entity).
        - Back: an entity about to be created with no entry gets the one it handed over before (`previous_unique_id`),
          when that entry's current unique id is no longer wanted, so a rollback or a flap loses nothing.
        """
        bridge = self._bridge.get(device)
        if bridge is None:
            return [], set()
        registry = er.async_get(self.hass)
        busy = set(self._migrating)
        hold: set[str] = set()
        moves: list[tuple[str, str, str]] = []

        def free(uid: str, platform: str) -> bool:
            return uid not in busy and registry.async_get_entity_id(platform, DOMAIN, uid) is None

        for spec in bridge.entities:
            new = self.unique_id(device, BRIDGE_SOURCE, spec.key)
            if new in busy:
                continue
            olds = [self.unique_id(device, source, key) for source, key in spec.replaces]
            if any(old in busy for old in olds):
                hold.add(new)
                continue
            for old in olds:
                if (old, new) not in self._failed_moves and registry.async_get_entity_id(spec.platform, DOMAIN, old):
                    moves.append((old, new, spec.platform))
                    busy.update((old, new))
                    break
        for uid, (platform, dev, source, spec) in list(self._created.items()):
            if dev != device or source != BRIDGE_SOURCE or uid in desired or uid in busy or spec is None:
                continue
            for r_source, r_key in spec.replaces:
                target = self.unique_id(device, r_source, r_key)
                if target not in desired or desired[target][0] != platform or not free(target, platform):
                    continue
                if (uid, target) not in self._failed_moves and registry.async_get_entity_id(platform, DOMAIN, uid):
                    moves.append((uid, target, platform))
                    busy.update((uid, target))
                break
        handed: dict[str, er.RegistryEntry] = {}
        for entry in er.async_entries_for_config_entry(registry, self.entry.entry_id):
            if entry.previous_unique_id and entry.unique_id not in desired:
                handed.setdefault(entry.previous_unique_id, entry)
        for uid, (platform, _, _) in desired.items():
            entry = handed.get(uid)
            if entry is None or entry.unique_id in busy or entry.domain != platform or (entry.unique_id, uid) in self._failed_moves:
                continue
            if free(uid, platform):
                moves.append((entry.unique_id, uid, platform))
                busy.update((entry.unique_id, uid))
        return moves, hold

    def _shadowed(self, device: str, desired: dict[str, tuple[str, str, EntitySpec | None]]) -> set[str]:
        """Return add-on unique ids whose entry a wanted entity of this device carries now (its `previous_unique_id`).

        Such an add-on entity is not created beside it: a bridge that briefly stops naming it in `replaces`, or an
        integration rolled back and forward again, would otherwise make a `_2` copy.
        """
        out = set()
        for entry in er.async_entries_for_config_entry(er.async_get(self.hass), self.entry.entry_id):
            prev = entry.previous_unique_id
            if not prev or prev not in desired or entry.unique_id not in desired:
                continue
            parsed = self._parse_unique_id(prev)
            if parsed is not None and parsed[0] == device and parsed[1] != BRIDGE_SOURCE:
                out.add(prev)
        return out

    @callback
    def _reconcile(self, device: str) -> None:
        """Make the device's entities (and images) match what its sources declare."""
        self._reconcile_images(device)
        desired = self._desired(device)
        for uid in self._shadowed(device, desired):
            del desired[uid]
        moves, hold = self._moves(device, desired)
        if moves:
            for old, new, _ in moves:
                self._migrating.update((old, new))
            self.hass.async_create_task(self._async_migrate(device, moves), eager_start=False)
        current = {uid: v for uid, v in self._created.items() if v[1] == device and not self._frozen(uid)}
        for uid, (platform, _, _, _) in current.items():
            if uid not in desired or desired[uid][0] != platform:
                self._remove_entity(uid, platform)
        to_add: dict[str, list[Entity]] = {}
        for uid, (platform, source, spec) in desired.items():
            if self._frozen(uid) or uid in hold:
                continue
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
            entity = self._platforms[platform][1](self, device, source, spec)
            self._adding[uid] = entity
            to_add.setdefault(platform, []).append(entity)
        for platform, entities in to_add.items():
            self._platforms[platform][0](entities)
        # entities of this device that a source with a config no longer declares (also while Home Assistant was down)
        declared_sources = {BRIDGE_SOURCE, *self._sources.get(device, {})} if device in self._bridge else set()
        self._prune_registry(lambda d, s: d == device and s in declared_sources, desired)

    def _frozen(self, unique_id: str) -> bool:
        """Return True for a unique id being handed over, or whose hand-over failed: neither created nor removed."""
        return unique_id in self._migrating or any(unique_id in pair for pair in self._failed_moves)

    async def _async_migrate(self, device: str, moves: list[tuple[str, str, str]]) -> None:
        """Hand each registry entry over to its new unique id, then build the device again.

        The entry keeps its entity id, so history, area, labels and other customisations stay. When the target has an
        entry too (one was made while the other was not yet handed over), the one to keep is the customised one, then
        the one whose entity id has no `_2` suffix, then the older; the other is removed, with a warning naming both.
        """
        try:
            for src, dst, platform in moves:
                try:
                    await self._async_move(src, dst, platform)
                except Exception:
                    self._failed_moves.add((src, dst))
                    _LOGGER.exception("Could not hand %s over to %s", src, dst)
        finally:
            for src, dst, _ in moves:
                self._migrating.difference_update((src, dst))
            if device in self._bridge:
                self._reconcile(device)

    async def _async_move(self, src: str, dst: str, platform: str) -> None:
        for uid in (src, dst):
            self._created.pop(uid, None)
            self._cancel_pending(uid)
            if (entity := self._entities.get(uid)) is not None:
                await entity.async_remove(force_remove=True)
        registry = er.async_get(self.hass)
        if (src_entry := registry.async_get(registry.async_get_entity_id(platform, DOMAIN, src) or "")) is None:
            return
        if (dst_entry := registry.async_get(registry.async_get_entity_id(platform, DOMAIN, dst) or "")) is not None:
            keep, drop = (src_entry, dst_entry) if _keep_rank(src_entry) >= _keep_rank(dst_entry) else (dst_entry, src_entry)
            _LOGGER.warning(
                "%s and %s are the same entity (%s, %s): keeping %s, removing %s",
                src_entry.entity_id, dst_entry.entity_id, src, dst, keep.entity_id, drop.entity_id,
            )
            registry.async_remove(drop.entity_id)
            if keep is dst_entry:
                return
        registry.async_update_entity(src_entry.entity_id, new_unique_id=dst)
        _LOGGER.info("%s handed over from %s to %s", src_entry.entity_id, src, dst)

    @callback
    def _remove_entity(self, unique_id: str, platform: str) -> None:
        self._created.pop(unique_id, None)
        self._cancel_pending(unique_id)
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
            if parsed is None or entry.unique_id in keep or self._frozen(entry.unique_id):
                continue
            if match(parsed[0], parsed[1]):
                self._created.pop(entry.unique_id, None)
                registry.async_remove(entry.entity_id)

    @callback
    def _remove_device(self, device: str) -> None:
        for image_key in [k for k in self._images if k[0] == device]:
            self._forget_image(image_key)
        for image_key in [k for k in self._pending_images if k[0] == device]:
            del self._pending_images[image_key]
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
