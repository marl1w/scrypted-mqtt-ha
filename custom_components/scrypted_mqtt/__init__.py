"""Scrypted MQTT: one device per Scrypted camera, built from the topics the Scrypted MQTT plugin publishes."""

from __future__ import annotations

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady

from .const import CONF_ROOT, DEFAULT_ROOT, PLATFORMS
from .hub import ScryptedMqttHub

type ScryptedMqttConfigEntry = ConfigEntry[ScryptedMqttHub]


async def async_setup_entry(hass: HomeAssistant, entry: ScryptedMqttConfigEntry) -> bool:
    """Set up Scrypted MQTT from a config entry."""
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("MQTT is not available")
    hub = ScryptedMqttHub(hass, entry, entry.data.get(CONF_ROOT, DEFAULT_ROOT))
    entry.runtime_data = hub
    # every platform registers with the hub before the first (retained) message arrives
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await hub.async_start()
    entry.async_on_unload(hub.async_stop)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ScryptedMqttConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
