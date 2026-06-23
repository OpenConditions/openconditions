# Copyright the OpenConditions authors.
# SPDX-License-Identifier: Apache-2.0

"""Run the resolver with uvicorn: ``python -m app``."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "app.service:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "4200")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
