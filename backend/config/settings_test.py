"""Settings for the test suite: the normal settings with a throwaway secret and a fake TomTom key.

The fake key means a test that accidentally reaches the real API fails instead of using the quota.
"""

import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-secret-key")

from config.settings import *  # noqa: E402,F403

TOMTOM_API_KEY = "test-key"
