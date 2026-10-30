"""Ways a plan request can fail, each with the HTTP status the API answers with."""


class PlanError(Exception):
    status = 500

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidInput(PlanError):
    """Something the user can fix in the form; `fields` maps form fields to what is wrong with them."""

    status = 400

    def __init__(self, message: str, fields: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.fields = fields or {}


class NoRoute(PlanError):
    """TomTom found no truck route; `code` is TomTom's reason (e.g. NO_ROUTE_FOUND)."""

    status = 400

    def __init__(self, message: str, code: str = "") -> None:
        super().__init__(message)
        self.code = code


class ServiceError(PlanError):
    """TomTom or Open-Meteo failed or answered with something unusable."""

    status = 502


class ServiceTimeout(ServiceError):
    """TomTom did not answer in time."""

    status = 504


class ServiceBusy(PlanError):
    """A service is rate limiting this server; the request can be retried later."""

    status = 503

    def __init__(self, message: str, retry_after_s: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s
