"""Sensors for Scrypted MQTT."""

from __future__ import annotations

from datetime import date, datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .contract import EntitySpec
from .entity import ScryptedMqttEntity, enum_or_none, setup_platform


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up sensors."""
    setup_platform(hass, entry, "sensor", async_add_entities, ScryptedMqttSensor)


class ScryptedMqttSensor(ScryptedMqttEntity, SensorEntity):
    """A text or numeric value."""

    platform_name = "sensor"

    def _apply_spec(self, spec: EntitySpec) -> None:
        super()._apply_spec(spec)
        self._attr_device_class = enum_or_none(SensorDeviceClass, spec.device_class)
        self._attr_state_class = enum_or_none(SensorStateClass, spec.state_class)
        self._attr_native_unit_of_measurement = spec.unit

    @property
    def native_value(self) -> str | float | date | datetime | None:
        """Return the value: a date or time for those classes, a number with a unit, state class or numeric class, else text."""
        value = self.raw_state
        if value is None:
            return None
        device_class = self._attr_device_class
        if device_class == SensorDeviceClass.TIMESTAMP:
            return dt_util.parse_datetime(value)
        if device_class == SensorDeviceClass.DATE:
            return dt_util.parse_date(value)
        if self._spec.unit or self._spec.state_class or (device_class is not None and device_class != SensorDeviceClass.ENUM):
            try:
                return float(value)
            except ValueError:
                return None
        return value
