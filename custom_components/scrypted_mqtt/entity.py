"""Base entity for Scrypted MQTT."""

from __future__ import annotations

from enum import StrEnum

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import slugify

from .contract import EntitySpec
from .hub import EntityFactory, ScryptedMqttHub


def enum_or_none[E: StrEnum](enum: type[E], value: str | None) -> E | None:
    """Return the enum member for value, None when it is not one."""
    if value is None:
        return None
    try:
        return enum(value)
    except ValueError:
        return None


class ScryptedMqttEntity(Entity):
    """An entity one source declares for one device."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    platform_name: str

    def __init__(self, hub: ScryptedMqttHub, device: str, source: str, spec: EntitySpec) -> None:
        """Initialize the entity."""
        self._hub = hub
        self._device = device
        self._source = source
        self._spec = spec
        self._attr_unique_id = hub.unique_id(device, source, spec.key)
        self._attr_device_info = DeviceInfo(identifiers={hub.device_identifier(device)})
        self._attr_entity_registry_enabled_default = spec.enabled
        # Used only when the entity is first registered; a rename made in Home Assistant wins afterwards. Only ids
        # under the device's own name are taken, so no source can claim an id another device's entity would get.
        device_spec = hub.device_spec(device)
        prefix = f"{slugify(device_spec.name)}_" if device_spec else None
        if spec.object_id and prefix and spec.object_id.startswith(prefix):
            self.entity_id = f"{self.platform_name}.{spec.object_id}"
        self._apply_spec(spec)

    def _apply_spec(self, spec: EntitySpec) -> None:
        self._attr_name = spec.name
        self._attr_icon = spec.icon
        self._attr_entity_category = enum_or_none(EntityCategory, spec.category)

    @property
    def available(self) -> bool:
        """Return True when the bridge, the device and this entity's source are there."""
        return self._hub.is_available(self._device, self._source)

    @property
    def raw_state(self) -> str | None:
        """Return the last state payload, None when unknown."""
        return self._hub.state(self._device, self._source, self._spec.key)

    async def async_added_to_hass(self) -> None:
        """Receive updates."""
        self._hub.attach(self.unique_id, self)

    async def async_will_remove_from_hass(self) -> None:
        """Stop receiving updates."""
        self._hub.detach(self.unique_id, self)

    @callback
    def handle_update(self) -> None:
        """Write the new state or availability."""
        if self.hass is not None:
            self.async_write_ha_state()

    @callback
    def update_spec(self, spec: EntitySpec) -> None:
        """Take a changed declaration of the same entity."""
        self._spec = spec
        self._apply_spec(spec)
        self.handle_update()


def setup_platform(
    hass: HomeAssistant,
    entry: ConfigEntry,
    platform: str,
    add: AddEntitiesCallback,
    factory: EntityFactory,
) -> None:
    """Hand the platform's add callback and entity factory to the hub."""
    hub: ScryptedMqttHub = entry.runtime_data
    hub.register_platform(platform, add, factory)
