"""Buttons for Scrypted MQTT."""

from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .contract import EntitySpec
from .entity import ScryptedMqttEntity, enum_or_none, setup_platform


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up buttons."""
    setup_platform(hass, entry, "button", async_add_entities, ScryptedMqttButton)


class ScryptedMqttButton(ScryptedMqttEntity, ButtonEntity):
    """An action the source carries out."""

    platform_name = "button"

    def _apply_spec(self, spec: EntitySpec) -> None:
        super()._apply_spec(spec)
        self._attr_device_class = enum_or_none(ButtonDeviceClass, spec.device_class)

    async def async_press(self) -> None:
        """Ask the source to carry it out."""
        await self._hub.async_command(self._device, self._source, self._spec.key, "PRESS")
