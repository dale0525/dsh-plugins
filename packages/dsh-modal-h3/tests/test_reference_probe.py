from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))

import modal_h3_contract as contract
from modal_h3_contract import H3ContractError, inspect_reference

try:
    from PIL import Image

    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False


def _resolve_binary(name: str) -> str | None:
    """Resolve an optional test dependency without failing collection when absent."""
    try:
        return contract.resolve_tool(name)
    except H3ContractError:
        return None


FFMPEG_PATH = _resolve_binary("ffmpeg")
FFPROBE_PATH = _resolve_binary("ffprobe")


class H3ReferenceProbeTests(unittest.TestCase):
    @unittest.skipUnless(HAS_PILLOW, "Pillow is required for image reference inspection")
    def test_probe_real_png_image(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "test_image.png"
            image = Image.new("RGB", (64, 64), color="blue")
            image.save(image_path, format="PNG")

            raw_bytes = image_path.read_bytes()
            expected_sha256 = hashlib.sha256(raw_bytes).hexdigest()
            expected_size = len(raw_bytes)

            result = inspect_reference(image_path, "image")
            self.assertEqual(result.get("kind"), "image")
            self.assertEqual(result.get("sha256"), expected_sha256)
            self.assertEqual(result.get("size_bytes"), expected_size)
            self.assertEqual(result.get("mime_type"), "image/png")

    @unittest.skipUnless(
        FFMPEG_PATH and FFPROBE_PATH,
        "ffmpeg and ffprobe are required for video reference inspection",
    )
    def test_probe_real_video_without_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            video_path = Path(temp_dir) / "video_no_audio.mp4"
            cmd = [
                FFMPEG_PATH,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=320x240:r=24:d=3",
                "-pix_fmt",
                "yuv420p",
                str(video_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            self.assertEqual(proc.returncode, 0, f"ffmpeg execution failed: {proc.stderr}")

            result = inspect_reference(video_path, "video")
            self.assertEqual(result.get("kind"), "video")
            self.assertAlmostEqual(result.get("duration_seconds"), 3.0, delta=0.5)
            self.assertFalse(result.get("has_audio"))

    @unittest.skipUnless(
        FFMPEG_PATH and FFPROBE_PATH,
        "ffmpeg and ffprobe are required for video reference inspection",
    )
    def test_probe_real_video_with_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            video_path = Path(temp_dir) / "video_with_audio.mp4"
            cmd = [
                FFMPEG_PATH,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=green:s=320x240:r=24:d=3",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                "-pix_fmt",
                "yuv420p",
                str(video_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            self.assertEqual(proc.returncode, 0, f"ffmpeg execution failed: {proc.stderr}")

            result = inspect_reference(video_path, "video")
            self.assertEqual(result.get("kind"), "video")
            self.assertAlmostEqual(result.get("duration_seconds"), 3.0, delta=0.5)
            self.assertTrue(result.get("has_audio"))

    @unittest.skipUnless(HAS_PILLOW, "Pillow is required to generate real image target for symlink")
    def test_probe_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            real_path = Path(temp_dir) / "real_target.png"
            image = Image.new("RGB", (10, 10), color="red")
            image.save(real_path, format="PNG")

            symlink_path = Path(temp_dir) / "symlink.png"
            try:
                symlink_path.symlink_to(real_path)
            except OSError as exc:
                self.skipTest(f"Symlinks not supported on this platform: {exc}")

            with self.assertRaises(H3ContractError):
                inspect_reference(symlink_path, "image")

    @unittest.skipUnless(
        FFMPEG_PATH and FFPROBE_PATH,
        "ffmpeg and ffprobe are required for audio reference inspection",
    )
    def test_probe_real_standalone_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_path = Path(temp_dir) / "reference.m4a"
            cmd = [
                FFMPEG_PATH,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:a",
                "aac",
                str(audio_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            self.assertEqual(proc.returncode, 0, f"ffmpeg execution failed: {proc.stderr}")

            result = inspect_reference(audio_path, "audio")
            self.assertEqual(result.get("kind"), "audio")
            self.assertAlmostEqual(result.get("duration_seconds"), 3.0, delta=0.5)

    def test_probe_rejects_nonexistent_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            nonexistent_path = Path(temp_dir) / "does_not_exist.png"
            with self.assertRaises(H3ContractError):
                inspect_reference(nonexistent_path, "image")


if __name__ == "__main__":
    unittest.main()
