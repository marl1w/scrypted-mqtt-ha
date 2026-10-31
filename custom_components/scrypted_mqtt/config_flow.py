"""Config flow for Scrypted MQTT."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import CONF_ROOT, DEFAULT_ROOT, DOMAIN
from .contract import is_valid_root


class ScryptedMqttConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask only for the topic root; the broker is Home Assistant's MQTT integration."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the user step."""
        if not await mqtt.async_wait_for_mqtt_client(self.hass):
            return self.async_abort(reason="mqtt_not_configured")
        errors: dict[str, str] = {}
        if user_input is not None:
            root = str(user_input[CONF_ROOT]).strip().strip("/")
            if is_valid_root(root):
                return self.async_create_entry(title="Scrypted MQTT", data={CONF_ROOT: root})
            errors[CONF_ROOT] = "invalid_root"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_ROOT, default=DEFAULT_ROOT): str}),
            errors=errors,
        )
