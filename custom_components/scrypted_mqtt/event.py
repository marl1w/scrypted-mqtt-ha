"""Events for Scrypted MQTT."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventDeviceClass, EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .contract import EntitySpec
from .entity import ScryptedMqttEntity, enum_or_none, setup_platform

# Types learnt from events beyond the declared ones; more are dropped, so the attribute cannot grow without end.
MAX_EVENT_TYPES = 64
# Attributes Home Assistant itself sets on an event state.
_RESERVED = ("event_type", "event_types")


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up events."""
    setup_platform(hass, entry, "event", async_add_entities, ScryptedMqttEvent)


class ScryptedMqttEvent(ScryptedMqttEntity, EventEntity):
    """Fires what the source sends on its event topic."""

    platform_name = "event"

    def _apply_spec(self, spec: EntitySpec) -> None:
        super()._apply_spec(spec)
        self._attr_device_class = enum_or_none(EventDeviceClass, spec.device_class)
        # keep types learnt from events, so a narrower declaration never rejects a type seen before
        known = getattr(self, "_attr_event_types", [])
        self._attr_event_types = list(dict.fromkeys([*known, *spec.event_types]))

    @callback
    def fire(self, event_type: str, attributes: dict[str, Any]) -> None:
        """Fire one event; a type not declared up front is added to the entity's types."""
        if event_type not in self._attr_event_types:
            if len(self._attr_event_types) >= MAX_EVENT_TYPES:
                return
            self._attr_event_types = [*self._attr_event_types, event_type]
        self._trigger_event(event_type, {k: v for k, v in attributes.items() if k not in _RESERVED})
        self.async_write_ha_state()
