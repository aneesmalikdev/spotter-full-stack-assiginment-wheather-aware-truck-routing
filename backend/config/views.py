"""The page: the built React app's index.html. Its scripts and styles are served from /static/."""

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_safe


@require_safe
@never_cache  # the page names the current build's hashed asset files
def index(request: HttpRequest) -> HttpResponse:
    page = settings.FRONTEND_DIST / "index.html"
    if not page.is_file():
        return HttpResponse(
            b"The front end is not built yet. Run `npm run build` in frontend/.",
            status=503,
            content_type="text/plain; charset=utf-8",
        )
    return HttpResponse(page.read_bytes(), content_type="text/html; charset=utf-8")
