"""The page at "/": the built React app's index.html, never cached."""

from typing import Any

import pytest
from django.test import Client


@pytest.fixture
def built(settings, tmp_path):
    """A stand-in for frontend/dist with an index.html."""
    (tmp_path / "index.html").write_text('<!doctype html><script src="/static/assets/index-abc123.js"></script>')
    settings.FRONTEND_DIST = tmp_path
    return tmp_path


def call(method: str, path: str = "/") -> Any:  # the test client's response; Django has no type hints
    return getattr(Client(), method)(path)


def test_the_page_is_the_built_index_html_and_is_never_cached(built):
    response = call("get")
    assert response.status_code == 200
    assert response["Content-Type"] == "text/html; charset=utf-8"
    assert b"/static/assets/index-abc123.js" in response.content
    assert "no-cache" in response["Cache-Control"]


def test_head_requests_are_answered(built):
    assert call("head").status_code == 200


def test_a_missing_build_says_how_to_make_one(settings, tmp_path):
    settings.FRONTEND_DIST = tmp_path
    response = call("get")
    assert response.status_code == 503
    assert b"npm run build" in response.content


def test_other_paths_and_methods_are_refused(built):
    assert call("get", "/routes/").status_code == 404
    assert call("post").status_code == 405
