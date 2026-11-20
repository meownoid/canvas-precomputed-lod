"""Prepare portable image LODs for Obsidian Canvas. Originals are never changed."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .processor import DEFAULT_SIZES, DEFAULT_WORKERS, Processor, Settings
from .terminal import MessageType, TerminalOutput


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="obsidian-prepare-lods", description=__doc__)
    parser.add_argument("vault", type=Path)
    parser.add_argument("--lod-dir", default="attachments/lod", help="visible, vault-relative output folder")
    parser.add_argument(
        "--sizes", default=",".join(str(size) for size in DEFAULT_SIZES), help="three ascending longest-edge targets"
    )
    parser.add_argument("--quality", type=int, default=85)
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help="parallel image processes (default: up to 4 CPUs; 1 is serial)",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--color",
        choices=("auto", "always", "never"),
        default="auto",
        help="color output (default: auto; respects NO_COLOR and TERM=dumb)",
    )
    args = parser.parse_args(argv)
    output = TerminalOutput(sys.stdout, args.color)
    errors = TerminalOutput(sys.stderr, args.color)
    try:
        sizes = tuple(int(part.strip()) for part in args.sizes.split(","))
        settings = Settings(sizes, args.quality)  # type: ignore[arg-type]
        processor = Processor(args.vault, args.lod_dir, settings, args.dry_run, output.log, workers=args.workers)
        return 1 if processor.run().failed else 0
    except (OSError, ValueError) as exc:
        errors.log(MessageType.ERROR, str(exc))
        return 2
