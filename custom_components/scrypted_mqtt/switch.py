"""Switches for Scrypted MQTT."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import ScryptedMqttEntity, setup_platform


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up switches."""
    setup_platform(hass, entry, "switch", async_add_entities, ScryptedMqttSwitch)


class ScryptedMqttSwitch(ScryptedMqttEntity, SwitchEntity):
    """A control; its state is whatever the source reports back, never what was asked."""

    platform_name = "switch"

    @property
    def is_on(self) -> bool | None:
        """Return the state the source confirmed, None when unknown."""
        return {"ON": True, "OFF": False}.get(self.raw_state or "")

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Ask the source to switch on."""
        await self._hub.async_command(self._device, self._source, self._spec.key, "ON")

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Ask the source to switch off."""
        await self._hub.async_command(self._device, self._source, self._spec.key, "OFF")
