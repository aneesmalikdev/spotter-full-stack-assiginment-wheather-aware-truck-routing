"""Django settings.

Every deployment-specific value comes from environment variables (see backend/.env.example).
For local development they are read from backend/.env.
"""

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"

load_dotenv(BASE_DIR / ".env")  # does nothing when the file is absent (e.g. on Vercel)


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


DEBUG = os.environ.get("DJANGO_DEBUG") == "1"

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured("Set DJANGO_SECRET_KEY (or DJANGO_DEBUG=1 for local development).")
    SECRET_KEY = "django-insecure-local-development-only"

ALLOWED_HOSTS = _env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")
if os.environ.get("VERCEL"):
    ALLOWED_HOSTS.append(".vercel.app")

# Read when a request needs it, so builds and tests work without it.
TOMTOM_API_KEY = os.environ.get("TOMTOM_API_KEY", "")

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "rest_framework",
    "planner",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",  # X-Frame-Options: DENY
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

DATABASES: dict = {}  # nothing is stored

CACHES = {
    "default": {
        # Per process: forecasts fetched by one request are reused by later ones on the same instance.
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "TIMEOUT": 3600,
        "OPTIONS": {"MAX_ENTRIES": 20_000, "CULL_FREQUENCY": 4},
    }
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["planner.api_errors.StrictJSONParser"],
    "EXCEPTION_HANDLER": "planner.api_errors.error_handler",
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

# The built React app: Vite emits hashed files to frontend/dist/assets, served at /static/assets/.
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [("assets", FRONTEND_DIST / "assets")] if (FRONTEND_DIST / "assets").is_dir() else []

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# Vercel redirects HTTP to HTTPS and sends Strict-Transport-Security on every domain itself, so Django
# does neither (`manage.py check --deploy` warnings W004 and W008).
SILENCED_SYSTEM_CHECKS = ["security.W004", "security.W008"]
CSRF_COOKIE_SECURE = True  # never set (no sessions or forms); this only answers check W016

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {
        "planner": {"handlers": ["console"], "level": "INFO", "propagate": False},  # once, not via Vercel's root handler too
        # Server errors. Django only prints them when DEBUG is on, and stderr is all Vercel keeps.
        "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
    },
}
