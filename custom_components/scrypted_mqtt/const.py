"""Constants for Scrypted MQTT."""

from homeassistant.const import Platform

DOMAIN = "scrypted_mqtt"
CONF_ROOT = "root"
DEFAULT_ROOT = "scrypted"

PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.CAMERA,
    Platform.EVENT,
    Platform.IMAGE,
    Platform.SENSOR,
    Platform.SWITCH,
]

# Seconds to wait for a snapshot from the bridge.
SNAPSHOT_TIMEOUT = 10
# Seconds after subscribing (with the bridge online) before devices and
# entities no source declares any more are removed.
STALE_GRACE = 180
