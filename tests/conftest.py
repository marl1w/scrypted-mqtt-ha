"""Shared fixtures."""

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Make the custom integration loadable in every test."""
    return enable_custom_integrations


@pytest.fixture
def expected_lingering_timers() -> bool:
    """The MQTT integration's own periodic timer outlives each test."""
    return True
