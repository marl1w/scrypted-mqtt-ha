"""Binary sensors for Scrypted MQTT."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .contract import EntitySpec
from .entity import ScryptedMqttEntity, enum_or_none, setup_platform


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up binary sensors."""
    setup_platform(hass, entry, "binary_sensor", async_add_entities, ScryptedMqttBinarySensor)


class ScryptedMqttBinarySensor(ScryptedMqttEntity, BinarySensorEntity):
    """An ON/OFF state."""

    platform_name = "binary_sensor"

    def _apply_spec(self, spec: EntitySpec) -> None:
        super()._apply_spec(spec)
        self._attr_device_class = enum_or_none(BinarySensorDeviceClass, spec.device_class)

    @property
    def is_on(self) -> bool | None:
        """Return the state, None when unknown."""
        return {"ON": True, "OFF": False}.get(self.raw_state or "")
