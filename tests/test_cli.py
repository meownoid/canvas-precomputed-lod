from __future__ import annotations

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from obsidian_prepare_lods.cli import main
from obsidian_prepare_lods.terminal import MessageType, TerminalOutput, format_size


class TTYStream(io.StringIO):
    def isatty(self) -> bool:
        return True


class TerminalTests(unittest.TestCase):
    def test_human_readable_sizes(self):
        cases = [
            (0, "0 B"),
            (1, "1 B"),
            (1023, "1023 B"),
            (1024, "1 KiB"),
            (1536, "1.5 KiB"),
            (512 * 1024, "512 KiB"),
            (32 * 1024**2, "32 MiB"),
            (1024**3, "1 GiB"),
            (1024**4, "1 TiB"),
            (1024**5, "1 PiB"),
            (1024**6, "1 EiB"),
        ]
        for size, expected in cases:
            with self.subTest(size=size):
                self.assertEqual(format_size(size), expected)

    def test_color_policy(self):
        cases = [
            (TTYStream, "auto", {}, True),
            (io.StringIO, "auto", {}, False),
            (TTYStream, "auto", {"NO_COLOR": "1"}, False),
            (TTYStream, "auto", {"NO_COLOR": ""}, True),
            (TTYStream, "auto", {"TERM": "dumb"}, False),
            (TTYStream, "never", {}, False),
            (io.StringIO, "always", {"NO_COLOR": "1", "TERM": "dumb"}, True),
        ]
        for stream_type, mode, environment, expected in cases:
            with self.subTest(stream=stream_type, mode=mode, environment=environment):
                stream = stream_type()
                message = "Finished preparing attachments/雨 photo.png (1/2)"
                with patch.dict(os.environ, environment, clear=True):
                    TerminalOutput(stream, mode).log(MessageType.SUCCESS, message)
                line = f"\033[32m{message}\033[0m" if expected else message
                self.assertEqual(stream.getvalue(), f"{line}\n")

    def test_type_colors_the_entire_message(self):
        cases = [
            (MessageType.DETAIL, "2", "ERROR photo.png"),
            (MessageType.INFO, "36", "Would generate preview.webp (500x250)"),
            (MessageType.SUCCESS, "32", "Rewrote Board.canvas"),
            (MessageType.SKIP, "33", "photo.png: no downscaling needed"),
            (MessageType.ERROR, "1;31", "Invalid settings"),
        ]
        for message_type, color, message in cases:
            with self.subTest(message_type=message_type):
                stream = io.StringIO()
                TerminalOutput(stream, "always").log(message_type, message)
                self.assertEqual(stream.getvalue(), f"\033[{color}m{message}\033[0m\n")


class CLITests(unittest.TestCase):
    def test_dry_run_color_modes(self):
        with tempfile.TemporaryDirectory() as vault:
            for mode in ("auto", "always", "never"):
                with self.subTest(mode=mode), patch("sys.stdout", new_callable=io.StringIO) as stdout:
                    self.assertEqual(main([vault, "--dry-run", "--color", mode]), 0)
                    result = stdout.getvalue()
                    self.assertEqual("\033[" in result, mode == "always")
                    self.assertIn("dry run", result)
                    summary = "Done.  canvases=0  rewritten=0  variants=0  reused=0  skipped=0  errors=0"
                    expected = f"\033[32m{summary}\033[0m" if mode == "always" else summary
                    self.assertEqual(result.splitlines()[-1], expected)

    def test_summary_highlights_failures_and_keeps_all_totals(self):
        with tempfile.TemporaryDirectory() as vault, patch("sys.stdout", new_callable=io.StringIO) as stdout:
            (Path(vault) / "Broken.canvas").write_text("{", encoding="utf-8")
            self.assertEqual(main([vault, "--dry-run", "--color", "always"]), 1)
        self.assertEqual(
            stdout.getvalue().splitlines()[-1],
            "\033[1;31mDone.  canvases=1  rewritten=0  variants=0  reused=0  skipped=0  errors=1\033[0m",
        )

    def test_setup_error_uses_stderr_color_policy(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sys.stdout", new_callable=io.StringIO) as stdout,
            patch("sys.stderr", new_callable=TTYStream) as stderr,
        ):
            self.assertEqual(main(["unused", "--quality", "0"]), 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "\033[1;31mquality must be between 1 and 100\033[0m\n")


if __name__ == "__main__":
    unittest.main()
