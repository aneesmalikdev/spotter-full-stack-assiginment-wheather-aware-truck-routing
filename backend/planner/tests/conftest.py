import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def empty_cache():
    """Each test starts with an empty forecast cache."""
    cache.clear()
    yield
    cache.clear()
