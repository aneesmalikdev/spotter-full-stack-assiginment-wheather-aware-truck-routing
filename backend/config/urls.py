from django.urls import path

from config.views import index
from planner.views import PlacesView, PlanView

urlpatterns = [
    path("", index, name="index"),
    path("api/plan/", PlanView.as_view(), name="plan"),
    path("api/places/", PlacesView.as_view(), name="places"),
]
