"""Images for Scrypted MQTT."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import ExtraStoredData, RestoredExtraData, RestoreEntity
from homeassistant.util import dt as dt_util

from .contract import EntitySpec
from .entity import ScryptedMqttEntity, setup_platform
from .hub import ScryptedMqttHub


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up images."""
    setup_platform(hass, entry, "image", async_add_entities, ScryptedMqttImage)


class ScryptedMqttImage(ScryptedMqttEntity, ImageEntity, RestoreEntity):
    """The last JPEG the source published on its image topic; the state is when it arrived."""

    platform_name = "image"
    _attr_content_type = "image/jpeg"

    def __init__(self, hub: ScryptedMqttHub, device: str, source: str, spec: EntitySpec) -> None:
        """Initialize the image."""
        ScryptedMqttEntity.__init__(self, hub, device, source, spec)
        ImageEntity.__init__(self, hub.hass)
        # digest and time of the image shown before a restart: the same image delivered again (it is retained) keeps its time
        self._restored: tuple[str, datetime] | None = None

    async def async_added_to_hass(self) -> None:
        """Take the time of the image shown before a restart, then the image the hub holds."""
        if (extra := await self.async_get_last_extra_data()) is not None:
            data = extra.as_dict()
            digest, updated = data.get("digest"), dt_util.parse_datetime(str(data.get("updated") or ""))
            if isinstance(digest, str) and updated is not None:
                self._restored = (digest, updated)
        self._refresh()
        await super().async_added_to_hass()

    @callback
    def _refresh(self) -> None:
        stored = self._hub.image(self._device, self._source, self._spec.key)
        if stored is None:
            # nothing received yet after a restart: the time of the picture shown before, until the source sends it or clears it
            self._attr_image_last_updated = self._restored[1] if self._restored else None
            return
        if self._restored is not None and self._restored[0] == stored.digest:
            self._attr_image_last_updated = self._restored[1]
            return
        self._restored = None
        self._attr_image_last_updated = stored.received

    @callback
    def handle_update(self) -> None:
        """A new image, or a change of availability."""
        self._refresh()
        super().handle_update()

    @callback
    def clear_image(self) -> None:
        """The source cleared its picture: unknown, with no restored time to fall back on."""
        self._restored = None
        self.handle_update()

    async def async_image(self) -> bytes | None:
        """Return the JPEG."""
        stored = self._hub.image(self._device, self._source, self._spec.key)
        return stored.content if stored else None

    @property
    def extra_restore_state_data(self) -> ExtraStoredData | None:
        """Keep the image's digest and time across restarts."""
        stored = self._hub.image(self._device, self._source, self._spec.key)
        if stored is None:
            # still waiting for the picture of before the restart: keep its record for the next one
            return RestoredExtraData({"digest": self._restored[0], "updated": self._restored[1].isoformat()}) if self._restored else None
        if self._attr_image_last_updated is None:
            return None
        return RestoredExtraData({"digest": stored.digest, "updated": self._attr_image_last_updated.isoformat()})
