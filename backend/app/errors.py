from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse


class AppError(HTTPException):
    def __init__(self, status_code: int, code: str, message: str | None = None, **extra):
        detail: dict = {"code": code, "message": message or code.replace("_", " ").capitalize()}
        detail.update(extra)
        super().__init__(status_code=status_code, detail=detail)


def unauthorized(code: str = "UNAUTHENTICATED", message: str | None = None) -> AppError:
    return AppError(401, code, message)


def forbidden(code: str, message: str | None = None, **extra) -> AppError:
    return AppError(403, code, message, **extra)


def not_found(code: str = "NOT_FOUND", message: str | None = None) -> AppError:
    return AppError(404, code, message)


def conflict(code: str, message: str | None = None, **extra) -> AppError:
    return AppError(409, code, message, **extra)


def unprocessable(code: str, message: str | None = None, **extra) -> AppError:
    return AppError(422, code, message, **extra)


def handler(_request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})