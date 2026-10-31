"""Cameras for Scrypted MQTT."""

from __future__ import annotations

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .contract import BRIDGE_SOURCE, EntitySpec
from .entity import setup_platform
from .hub import CAMERA_KEY, ScryptedMqttHub


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    """Set up cameras."""
    setup_platform(hass, entry, "camera", async_add_entities, ScryptedMqttCamera)


class ScryptedMqttCamera(Camera):
    """The device's camera: live view from the bridge's stream URL, snapshots over MQTT."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_should_poll = False
    _attr_supported_features = CameraEntityFeature.STREAM

    def __init__(self, hub: ScryptedMqttHub, device: str, source: str, spec: EntitySpec | None) -> None:
        """Initialize the camera."""
        super().__init__()
        self._hub = hub
        self._device = device
        self._attr_unique_id = hub.unique_id(device, BRIDGE_SOURCE, CAMERA_KEY)
        self._attr_device_info = DeviceInfo(identifiers={hub.device_identifier(device)})

    @property
    def available(self) -> bool:
        """Return True while the bridge publishes the device."""
        return self._hub.is_available(self._device, BRIDGE_SOURCE)

    async def stream_source(self) -> str | None:
        """Return Scrypted's rebroadcast of the camera."""
        spec = self._hub.device_spec(self._device)
        return spec.stream if spec else None

    async def async_camera_image(self, width: int | None = None, height: int | None = None) -> bytes | None:
        """Return a snapshot taken by Scrypted."""
        return await self._hub.async_snapshot(self._device, width, height)

    async def async_added_to_hass(self) -> None:
        """Receive updates."""
        await super().async_added_to_hass()
        self._hub.attach(self.unique_id, self)

    async def async_will_remove_from_hass(self) -> None:
        """Stop receiving updates."""
        self._hub.detach(self.unique_id, self)
        await super().async_will_remove_from_hass()

    @callback
    def handle_update(self) -> None:
        """Follow a changed stream URL and write the new availability."""
        spec = self._hub.device_spec(self._device)
        if self.stream is not None and spec is not None and spec.stream and self.stream.source != spec.stream:
            self.stream.update_source(spec.stream)
        if self.hass is not None:
            self.async_write_ha_state()

    @callback
    def update_spec(self, spec: EntitySpec) -> None:
        """The camera has no declaration of its own."""
