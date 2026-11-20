"""Terminal presentation for typed progress messages."""

from __future__ import annotations

import os
from enum import Enum
from typing import TextIO


class MessageType(Enum):
    DETAIL = "2"
    INFO = "36"
    SUCCESS = "32"
    SKIP = "33"
    ERROR = "1;31"


def format_size(size: int) -> str:
    """Format a byte count with binary units and at most one decimal place."""
    if size < 1024:
        return f"{size} B"
    divisor = 1024
    for unit in ("KiB", "MiB", "GiB", "TiB", "PiB", "EiB"):
        if size < divisor * 1024 or unit == "EiB":
            value = f"{size / divisor:.1f}".removesuffix(".0")
            return f"{value} {unit}"
        divisor *= 1024
    raise AssertionError("unreachable")


class TerminalOutput:
    def __init__(self, stream: TextIO, color: str = "auto") -> None:
        self.stream = stream
        self.color = color == "always" or (
            color == "auto" and stream.isatty() and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"
        )

    def log(self, message_type: MessageType, message: str) -> None:
        if self.color:
            message = f"\033[{message_type.value}m{message}\033[0m"
        print(message, file=self.stream, flush=True)
