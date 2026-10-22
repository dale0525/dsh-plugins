"""Single, fail-closed Ref2VA production contract shared by the H3 CLIs and worker."""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import math
import mimetypes
import os
import re
import subprocess
import shutil
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = Path(os.environ.get("DSH_NOVEL_H3_ASSET_ROOT", REPO_ROOT / "assets" / "h3" / "modal-minimax-h3-video"))
GRAPH_PATH = ASSET_ROOT / "minimax_h3_ref2va_turbo6_api.json"
MODEL_MANIFEST_PATH = ASSET_ROOT / "model-manifest.json"

APP_NAME = os.environ.get("DSH_NOVEL_MODAL_APP_NAME", "dsh-novel-minimax-h3-ref2va-turbo6")
MODEL_VOLUME_NAME = os.environ.get("DSH_NOVEL_MODAL_MODEL_VOLUME", "dsh-novel-minimax-h3-models-candidate-bcb148f1")
STATE_VOLUME_NAME = os.environ.get("DSH_NOVEL_MODAL_STATE_VOLUME", "dsh-novel-minimax-h3-ref2va-turbo6-state")
PRODUCTION_WORKER_NAME = "Ref2VAProductionWorker"
CANONICAL_BOOTSTRAP_RECEIPT_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.bootstrap.v1"
LEGACY_BOOTSTRAP_RECEIPT_SCHEMA = "agentnovel.modal-h3.ref2va-turbo6.bootstrap.v1"
BOOTSTRAP_RECEIPT_SCHEMA = CANONICAL_BOOTSTRAP_RECEIPT_SCHEMA
BOOTSTRAP_RECEIPT_NAME = ".dsh-novel-ref2va-turbo6-receipt.json"
LEGACY_BOOTSTRAP_RECEIPT_NAME = ".agentnovel-ref2va-turbo6-receipt.json"

CANONICAL_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.request.v2"
LEGACY_SCHEMA = "agentnovel.modal-h3.ref2va-turbo6.request.v2"
SCHEMA = CANONICAL_SCHEMA
CANONICAL_PREFLIGHT_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.preflight.v2"
LEGACY_PREFLIGHT_SCHEMA = "agentnovel.modal-h3.ref2va-turbo6.preflight.v2"
MODEL_MANIFEST_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.manifest.v1"
RUNTIME_RELEASE_SCHEMA = "dsh-novel.modal-h3.runtime-release.v1"
REPORT_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.report.v2"
FAILURE_SCHEMA = "dsh-novel.modal-h3.ref2va-turbo6.failure.v1"
WORKER_CONTRACT_REVISION = "2026-10-06-hybrid-base-ref2va-media-map-v6"
MODEL_REVISION = "93acf8c91365d40dc32a3abd19af06df6b6f7c65"
MODEL_REPOSITORY = "Comfy-Org/MiniMax-H3"
T8_COMMIT = "5ff46c253192e9d8cae185280fd34f4b4add063b"
T8_REPOSITORY = "T8mars/comfyui-minimax-h3-audio-T8"
TURBO_LORA_REPOSITORY = "t8star/minimax-h3-4step-turbo-loras-comfyui-exp"
TURBO_LORA_REVISION = "01f469a8202af0dce8ac3be08ab20009d19f00bd"
TURBO_LORA_SOURCE_PATH = "minimax_h3_turbo_4步加速ema_comfyui.safetensors"
# Production base: the FL2VA unpruned int8 checkpoint with blocks 25-49 AdaLN
# transplanted from Ref2VA. Treat it as Ref2VA for reference packing.
HYBRID_MODEL_REPOSITORY = "sandpies/Minimax-H3-fl2va-ref2va-hybrid-unpruned-int8"
HYBRID_MODEL_REVISION = "f6c3ed3748f553b390c091988cdfc9eafded5e3e"
HYBRID_MODEL_SOURCE_PATH = "minimax_h3_hybrid_fl2va_ref2va_b25-49_unpruned_int8.safetensors"
HYBRID_MODEL_PATH = "diffusion_models/minimax_h3_hybrid_fl2va_ref2va_b25-49_unpruned_int8.safetensors"
HYBRID_MODEL_SHA256 = "c0c028f2e26fe0018ea730abfa2fae91b11704ae8bd93065fed3f43a043a6417"
HYBRID_MODEL_SIZE_BYTES = 34038892614
# MysticXXX V1 is published on Civitai only and has no Hugging Face mirror, so
# the manifest pins a direct download URL instead of a repo/revision pair.
MYSTIC_LORA_SOURCE_URL = "https://civitai.com/api/download/models/3226233"
MYSTIC_LORA_FILENAME = "MysticXXX_MMH3-V1.safetensors"
MYSTIC_LORA_PATH = "loras/MysticXXX_MMH3-V1.safetensors"
MYSTIC_LORA_SHA256 = "7dd837f4c5420d4ec59f3ff1757b3f9d264a6c0f120d65d9c4f59c77584dd0be"
MYSTIC_LORA_SIZE_BYTES = 596451528
MYSTIC_LORA_STRENGTH = 0.5
# ComfyUI's upstream H3-specific peak-memory fix (#15486).
COMFY_COMMIT = "62b3c94bd45154f6486c7abf1b9efcacee96ea69"
CUDA_IMAGE = "nvidia/cuda:13.0.3-cudnn-devel-ubuntu22.04"
TORCH_INDEX = "https://download.pytorch.org/whl/cu130"
TORCH_VERSION = "2.11.0+cu130"
TORCHVISION_VERSION = "0.26.0+cu130"
TORCHAUDIO_VERSION = "2.11.0+cu130"
# The Modal client is deliberately absent from the repository pixi environment and
# is fetched on demand; pin it so client-side protocol drift cannot alter a run.
MODAL_CLIENT_SPEC = os.environ.get("DSH_NOVEL_MODAL_CLIENT_SPEC", "modal-client==1.5.5")

# Release qualification always starts on RTX PRO 6000. The cu130 measurements
# selected RTX PRO 6000 as the lowest-cost passing card, with B200 as fallback.
QUALIFICATION_GPU = "RTX-PRO-6000"
GPU_PLACEMENT = ("RTX-PRO-6000", "B200")
GPU_RATE_USD_PER_SECOND = {
    "B200": 0.001736,
    "RTX-PRO-6000": 0.000842,
    "A100-80GB": 0.000694,
    "L40S": 0.000542,
}
GPU_RATE_USD_PER_HOUR = {key: value * 3600 for key, value in GPU_RATE_USD_PER_SECOND.items()}
GPU_MIN_MEMORY_MIB = {
    "B200": 170000,
    "RTX-PRO-6000": 90000,
    "A100-80GB": 75000,
    "L40S": 45000,
}
GPU_PRICE_RETRIEVED_AT = "2026-08-10"
ADMISSION_RATE_USD_PER_HOUR = 8.00
BUDGET_USD = 3.00
STOP_READBACK_RESERVE_USD = 0.20
MAX_ATTEMPTS = 2
MAX_COST_USD_PER_ATTEMPT = (BUDGET_USD - STOP_READBACK_RESERVE_USD) / MAX_ATTEMPTS
MAX_EXECUTION_SECONDS_PER_ATTEMPT = math.floor(
    (MAX_COST_USD_PER_ATTEMPT / ADMISSION_RATE_USD_PER_HOUR) * 3600
)
WIDTH, HEIGHT, FPS, DEFAULT_DURATION_SECONDS, GENERATION_FRAMES, OUTPUT_FRAMES, STEPS = 1344, 768, 24, 4.0, 107, 96, 6
MIN_DURATION_SECONDS, MAX_DURATION_SECONDS = 4.0, 15.0
MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
MAX_REFERENCE_FILES = 12
MIN_REFERENCE_DURATION_SECONDS = 2.0
MAX_REFERENCE_DURATION_SECONDS = 15.0
MAX_REFERENCE_VIDEO_TOTAL_SECONDS = 15.0
MAX_REFERENCE_AUDIO_TOTAL_SECONDS = 15.0
MAX_PROMPT_CHARS = 32_000
MAX_REFERENCE_BYTES_PER_FILE = 512 * 1024 * 1024
MAX_REFERENCE_BYTES_TOTAL = 1024 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024 * 1024
SAMPLER = {"kind": "dual_clock_t8", "shift_video": 12.0, "shift_audio": 3.0}


class H3ContractError(ValueError):
    """A request or local preflight does not satisfy the only supported contract."""


PROMPT_SECTIONS = (
    "subject_definitions", "summary", "retention_analysis",
    "detailed_description", "overall_soundscape", "non_diegetic_music",
)
PROMPT_TAG_RE = re.compile(r"<(Picture|Video|Audio)\s+(\d+)>", re.IGNORECASE)
UNSUPPORTED_PROMPT_MODE_RE = re.compile(
    r"\b(?:T2VA|I2VA|FL2VA|L2VA|Hybrid)\b|"
    r"\[(?:[^\]]*\+\s*)?(?:keyframe completion|video editing|video continuation|audio reuse)(?:\s*\+[^\]]*)?\]",
    re.IGNORECASE,
)
BOUNDARY_PICTURE_RE = re.compile(
    r"(?:<Picture\s+\d+>[\s\S]{0,512}?\b(?:first|last|opening|ending)[ -]frame\b|"
    r"\b(?:first|last|opening|ending)[ -]frame\b[\s\S]{0,512}?<Picture\s+\d+>)",
    re.IGNORECASE,
)


def validate_ref2va_prompt(
    prompt: str,
    refs: Mapping[str, Sequence[Mapping[str, Any]]],
    *,
    effective_duration_seconds: float,
) -> None:
    """Reject prompt modes and labels that the Ref2VA-only transport cannot honor."""
    section_positions: list[int] = []
    for section in PROMPT_SECTIONS:
        matches = list(re.finditer(rf"(?m)^{re.escape(section)}:\s*$", prompt))
        if len(matches) != 1:
            raise H3ContractError(f"Ref2VA prompt requires exactly one {section}: section")
        section_positions.append(matches[0].start())
    if section_positions != sorted(section_positions):
        raise H3ContractError("Ref2VA prompt sections are out of order")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise H3ContractError(f"Ref2VA prompt exceeds {MAX_PROMPT_CHARS} characters")
    if UNSUPPORTED_PROMPT_MODE_RE.search(prompt):
        raise H3ContractError("prompt requests a mode unavailable from the Ref2VA-only production route")
    duration_text = f"{effective_duration_seconds:g}"
    if not re.search(
        rf"\beffective duration(?:\s+of|\s+is|\s*:)?\s+{re.escape(duration_text)}\s+seconds\b",
        prompt,
        re.IGNORECASE,
    ):
        raise H3ContractError(
            f"Ref2VA prompt must state the effective duration of {duration_text} seconds"
        )

    media_map = prompt_media_map(refs)
    available = {
        "picture": len(media_map["pictures"]),
        "video": len(media_map["videos"]),
        "audio": len(media_map["audios"]),
    }
    used = {kind: [] for kind in available}
    for kind, ordinal_text in PROMPT_TAG_RE.findall(prompt):
        normalized = kind.lower()
        ordinal = int(ordinal_text)
        if ordinal < 1 or ordinal > available[normalized]:
            raise H3ContractError(
                f"prompt references <{kind.title()} {ordinal}> but only {available[normalized]} {normalized} inputs exist"
            )
        used[normalized].append(ordinal)
    for kind, count in available.items():
        expected = list(range(1, count + 1))
        first_occurrences = list(dict.fromkeys(used[kind]))
        if first_occurrences != expected:
            missing = ", ".join(f"<{kind.title()} {index}>" for index in sorted(set(expected) - set(first_occurrences)))
            raise H3ContractError(
                f"Ref2VA prompt must introduce ordered {kind} labels in sequence" + (f": {missing}" if missing else "")
            )

    boundary_matches = list(BOUNDARY_PICTURE_RE.finditer(prompt))
    for match in boundary_matches:
        context = prompt[max(0, match.start() - 160):match.end() + 160]
        if not re.search(r"best[ -]effort", context, re.IGNORECASE):
            raise H3ContractError("opening/ending Picture targets must be labeled best effort")


def duration_frame_contract(duration_seconds: float | str) -> dict[str, float | int]:
    """Quantize a 4-15 second request to the nearest 24fps frame and H3 grid."""
    if isinstance(duration_seconds, bool):
        raise H3ContractError("duration_seconds must be a finite number")
    try:
        requested = Decimal(str(duration_seconds))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise H3ContractError("duration_seconds must be a finite number") from exc
    if not requested.is_finite():
        raise H3ContractError("duration_seconds must be a finite number")
    if not Decimal(str(MIN_DURATION_SECONDS)) <= requested <= Decimal(str(MAX_DURATION_SECONDS)):
        raise H3ContractError(
            f"duration_seconds must be between {MIN_DURATION_SECONDS:g} and {MAX_DURATION_SECONDS:g} seconds"
        )
    output_frames = int((requested * FPS).to_integral_value(rounding=ROUND_HALF_UP))
    generation_frames = max(5, math.ceil((output_frames - 5) / 17) * 17 + 5)
    effective_duration = output_frames / FPS
    return {
        "requested_duration_seconds": float(requested),
        "duration_seconds": round(effective_duration, 6),
        "output_frames": output_frames,
        "generation_frames": generation_frames,
    }


def canonical_json(value: Mapping[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def runtime_release() -> dict[str, Any]:
    """Return the exact immutable runtime identity used for receipts and attempts."""
    try:
        graph_bytes = GRAPH_PATH.read_bytes()
        manifest_bytes = MODEL_MANIFEST_PATH.read_bytes()
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise H3ContractError("runtime release assets are missing or invalid") from exc
    if not isinstance(manifest, Mapping) or manifest.get("schema") != MODEL_MANIFEST_SCHEMA:
        raise H3ContractError("runtime release manifest schema is not the pinned DSH-Novel Turbo6 schema")
    components = {
        "schema": RUNTIME_RELEASE_SCHEMA,
        "manifest_schema": manifest["schema"],
        "worker_contract_revision": WORKER_CONTRACT_REVISION,
        "comfy_commit": COMFY_COMMIT,
        "t8_commit": T8_COMMIT,
        "cuda_image": CUDA_IMAGE,
        "torch": TORCH_VERSION,
        "torchvision": TORCHVISION_VERSION,
        "torchaudio": TORCHAUDIO_VERSION,
        "graph_sha256": hashlib.sha256(graph_bytes).hexdigest(),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }
    return {
        **components,
        "fingerprint": hashlib.sha256(canonical_json(components).encode("utf-8")).hexdigest(),
    }


def expected_bootstrap_receipt(manifest: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Build the exact receipt that admits a deployed account into production."""
    if manifest is None:
        try:
            loaded = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise H3ContractError("model manifest is missing or invalid") from exc
        manifest = loaded
    if not isinstance(manifest, Mapping) or manifest.get("schema") != MODEL_MANIFEST_SCHEMA:
        raise H3ContractError("model manifest schema is not the pinned DSH-Novel Turbo6 schema")
    artifacts = manifest.get("artifacts") if isinstance(manifest, Mapping) else None
    if not isinstance(artifacts, list):
        raise H3ContractError("model manifest has no artifact list")
    verified: list[dict[str, Any]] = []
    for item in artifacts:
        if not isinstance(item, Mapping):
            raise H3ContractError("model manifest contains an invalid artifact")
        try:
            verified.append({
                "role": item["role"], "path": item["path"],
                "sha256": item["sha256"], "size_bytes": item["size_bytes"],
            })
        except KeyError as exc:
            raise H3ContractError(f"model manifest artifact is missing {exc.args[0]}") from exc
    return {
        "schema": BOOTSTRAP_RECEIPT_SCHEMA,
        "verified": verified,
        "runtime_release": runtime_release(),
    }


def validate_bootstrap_receipt(receipt: Mapping[str, Any]) -> dict[str, Any]:
    expected = expected_bootstrap_receipt()
    if not isinstance(receipt, Mapping):
        raise H3ContractError("bootstrap receipt does not match the pinned model manifest and runtime release")
    if dict(receipt) == expected:
        return expected
    if receipt.get("schema") in {BOOTSTRAP_RECEIPT_SCHEMA, LEGACY_BOOTSTRAP_RECEIPT_SCHEMA}:
        if receipt.get("verified") == expected["verified"]:
            rel = receipt.get("runtime_release")
            if isinstance(rel, Mapping):
                if rel.get("fingerprint") == expected["runtime_release"]["fingerprint"]:
                    return expected
    raise H3ContractError("bootstrap receipt does not match the pinned model manifest and runtime release")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_tool(name: str) -> str:
    """Locate a required local binary, preferring PATH and falling back to the repo pixi environment."""
    found = shutil.which(name)
    if found:
        return found
    candidates = [
        REPO_ROOT / ".pixi" / "envs" / "default" / "bin" / name,
        Path("/opt/homebrew/bin") / name,
        Path("/usr/local/bin") / name,
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise H3ContractError(f"required local tool is unavailable: {name}")


def modal_client_command(*arguments: str) -> list[str]:
    """Build a command that runs inside the pinned on-demand Modal client environment."""
    return ["pixi", "exec", "--spec", MODAL_CLIENT_SPEC, "python", *arguments]


def _ffprobe(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [resolve_tool("ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=False, capture_output=True, text=True,
    )
    if result.returncode:
        raise H3ContractError(f"ffprobe cannot decode {path.name}: {result.stderr.strip()[:300]}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise H3ContractError(f"ffprobe returned invalid JSON for {path.name}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("streams"), list):
        raise H3ContractError(f"ffprobe returned no streams for {path.name}")
    return payload


def inspect_reference(path: Path, kind: str) -> dict[str, Any]:
    """Decode a regular local reference without retaining its source path."""
    path = Path(path)
    if kind not in {"image", "video", "audio"}:
        raise H3ContractError(f"unsupported reference kind: {kind}")
    if path.is_symlink() or not path.is_file():
        raise H3ContractError(f"{kind} reference must be a regular non-symlink file")
    duration_seconds = None
    has_audio = False
    if kind == "image":
        try:
            from PIL import Image
            with Image.open(path) as image:
                image.verify()
        except Exception as exc:
            raise H3ContractError(f"image reference cannot be decoded: {path.name}") from exc
    else:
        probe = _ffprobe(path)
        stream_type = "video" if kind == "video" else "audio"
        if not any(item.get("codec_type") == stream_type for item in probe["streams"] if isinstance(item, dict)):
            raise H3ContractError(f"{path.name} has no decodable {stream_type} stream")
        if kind == "video":
            has_audio = any(
                item.get("codec_type") == "audio"
                for item in probe["streams"]
                if isinstance(item, dict)
            )
        try:
            duration_seconds = float((probe.get("format") or {}).get("duration"))
        except (TypeError, ValueError):
            duration_seconds = None
        if duration_seconds is None or not math.isfinite(duration_seconds):
            raise H3ContractError(f"{kind} reference has no finite duration: {path.name}")
    descriptor = {
        "kind": kind,
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
        "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
    }
    if duration_seconds is not None:
        descriptor["duration_seconds"] = round(duration_seconds, 6)
    if kind == "video":
        descriptor["has_audio"] = has_audio
    return descriptor


def _references(items: Sequence[Path], kind: str) -> list[dict[str, Any]]:
    return [inspect_reference(Path(item), kind) for item in items]


def _validate_reference_limits(refs: Mapping[str, Sequence[Mapping[str, Any]]]) -> None:
    limits = {
        "images": MAX_REFERENCE_IMAGES,
        "videos": MAX_REFERENCE_VIDEOS,
        "audios": MAX_REFERENCE_AUDIOS,
    }
    total_bytes = 0
    for category, limit in limits.items():
        items = refs.get(category, ())
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes, bytearray)):
            raise H3ContractError(f"reference {category} must be an array")
        if len(items) > limit:
            raise H3ContractError(f"Ref2VA accepts at most {limit} reference {category}")
        for item in items:
            if not isinstance(item, Mapping):
                raise H3ContractError(f"reference {category} contains an invalid descriptor")
            kind = {"images": "image", "videos": "video", "audios": "audio"}[category]
            if item.get("kind") != kind:
                raise H3ContractError(f"reference {category} descriptor kind is invalid")
            digest = item.get("sha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                raise H3ContractError(f"reference {category} descriptor SHA-256 is invalid")
            try:
                size = int(item.get("size_bytes"))
            except (TypeError, ValueError):
                raise H3ContractError(f"reference {category} descriptor size is invalid") from None
            if size < 0 or size > MAX_REFERENCE_BYTES_PER_FILE:
                raise H3ContractError(f"reference {category} descriptor size exceeds the per-file limit")
            total_bytes += size
    if sum(len(refs.get(category, ())) for category in limits) > MAX_REFERENCE_FILES:
        raise H3ContractError(f"Ref2VA accepts at most {MAX_REFERENCE_FILES} reference files in total")
    if total_bytes > MAX_REFERENCE_BYTES_TOTAL:
        raise H3ContractError("Ref2VA reference bytes exceed the total transport limit")
    for category, total_limit in (
        ("videos", MAX_REFERENCE_VIDEO_TOTAL_SECONDS),
        ("audios", MAX_REFERENCE_AUDIO_TOTAL_SECONDS),
    ):
        durations: list[float] = []
        for item in refs.get(category, ()):
            try:
                duration = float(item.get("duration_seconds"))
            except (TypeError, ValueError):
                raise H3ContractError(f"reference {category[:-1]} duration is invalid") from None
            if not math.isfinite(duration):
                raise H3ContractError(f"reference {category[:-1]} duration must be finite")
            durations.append(duration)
        if any(
            duration < MIN_REFERENCE_DURATION_SECONDS or duration > MAX_REFERENCE_DURATION_SECONDS
            for duration in durations
        ):
            raise H3ContractError(
                f"each reference {category[:-1]} must be {MIN_REFERENCE_DURATION_SECONDS:g}-"
                f"{MAX_REFERENCE_DURATION_SECONDS:g} seconds"
            )
        if sum(durations) > total_limit + 1e-6:
            raise H3ContractError(
                f"total reference {category} duration must not exceed {total_limit:g} seconds"
            )


def validate_transport_references(
    request: Mapping[str, Any], references: Any,
) -> list[dict[str, Any]]:
    """Validate and decode the remote reference envelope against the admitted request."""
    refs = request.get("references")
    if not isinstance(refs, Mapping) or not isinstance(references, list):
        raise H3ContractError("transport references are missing or invalid")
    _validate_reference_limits(refs)
    if len(references) > MAX_REFERENCE_FILES:
        raise H3ContractError("transport references exceed the file count limit")
    expected: list[Mapping[str, Any]] = []
    for category in ("images", "videos", "audios"):
        items = refs.get(category, ())
        if not isinstance(items, Sequence):
            raise H3ContractError(f"request {category} references are invalid")
        expected.extend(items)
    if len(references) != len(expected):
        raise H3ContractError("transport reference count does not match the admitted request")
    decoded: list[dict[str, Any]] = []
    total_bytes = 0
    for index, (item, descriptor) in enumerate(zip(references, expected)):
        if not isinstance(item, Mapping) or not isinstance(descriptor, Mapping):
            raise H3ContractError(f"transport reference {index} is invalid")
        encoded = item.get("data_base64")
        if not isinstance(encoded, str):
            raise H3ContractError(f"transport reference {index} has no base64 payload")
        try:
            expected_encoded_length = 4 * ((int(descriptor["size_bytes"]) + 2) // 3)
        except (KeyError, TypeError, ValueError):
            raise H3ContractError(f"transport reference {index} has an invalid descriptor size") from None
        if len(encoded) != expected_encoded_length:
            raise H3ContractError(f"transport reference {index} base64 length does not match its descriptor")
        try:
            payload = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
            raise H3ContractError(f"transport reference {index} base64 payload is invalid") from exc
        descriptor_without_kind = dict(descriptor)
        expected_transport = {**descriptor_without_kind, "kind": descriptor["kind"]}
        supplied_descriptor = {key: value for key, value in item.items() if key != "data_base64"}
        if supplied_descriptor != expected_transport:
            raise H3ContractError(f"transport reference {index} descriptor does not match the admitted request")
        if len(payload) != int(descriptor["size_bytes"]):
            raise H3ContractError(f"transport reference {index} byte length does not match its descriptor")
        if hashlib.sha256(payload).hexdigest() != descriptor["sha256"]:
            raise H3ContractError(f"transport reference {index} digest does not match its descriptor")
        total_bytes += len(payload)
        decoded.append({**expected_transport, "payload": payload})
    if total_bytes > MAX_REFERENCE_BYTES_TOTAL:
        raise H3ContractError("transport references exceed the total byte limit")
    return decoded


def validate_result_envelope(
    result: Any, *, request: Mapping[str, Any], preflight: Mapping[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    """Validate the only JSON result shape accepted by the local production CLI."""
    if not isinstance(result, Mapping):
        raise H3ContractError("Modal result envelope must be an object")
    encoded = result.get("video_base64")
    report = result.get("report")
    if not isinstance(encoded, str) or not encoded:
        raise H3ContractError("Modal result envelope has no video payload")
    if len(encoded) > 4 * ((MAX_RESULT_BYTES + 2) // 3):
        raise H3ContractError("Modal result video payload exceeds the local result limit")
    try:
        payload = base64.b64decode(encoded.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise H3ContractError("Modal result video payload is invalid base64") from exc
    if not payload or len(payload) > MAX_RESULT_BYTES:
        raise H3ContractError("Modal result video payload has an invalid size")
    if not isinstance(report, Mapping) or report.get("schema") != REPORT_SCHEMA:
        raise H3ContractError("Modal result report schema is invalid")
    if report.get("request_id") != preflight.get("request_id"):
        raise H3ContractError("Modal result report request_id does not match the submitted request")
    release = report.get("runtime_release")
    expected_release = preflight.get("runtime_release")
    if not isinstance(release, Mapping) or not isinstance(expected_release, Mapping):
        raise H3ContractError("Modal result report runtime release is missing")
    if release.get("fingerprint") != expected_release.get("fingerprint"):
        raise H3ContractError("Modal result report runtime release does not match the submitted request")
    profile = report.get("request_profile")
    if not isinstance(profile, Mapping):
        raise H3ContractError("Modal result report request profile is missing")
    expected_profile = {
        "schema": request.get("schema"),
        "requested_duration_seconds": request.get("requested_duration_seconds"),
        "duration_seconds": request.get("duration_seconds"),
        "generation_frames": request.get("generation_frames"),
        "output_frames": request.get("output_frames"),
        "steps": request.get("steps"),
        "reference_counts": {
            category: len(request.get("references", {}).get(category, ()))
            for category in ("images", "videos", "audios")
        },
    }
    if dict(profile) != expected_profile:
        raise H3ContractError("Modal result report request profile does not match the submitted request")
    return payload, dict(report)


def prompt_media_map(refs: Mapping[str, Sequence[Mapping[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    """Expose H3's actual Picture/Video/Audio label order without source paths."""
    pictures = [
        {"ordinal": index, "source": "reference_image", "source_ordinal": index}
        for index, _ in enumerate(refs.get("images", ()), 1)
    ]
    videos = [
        {"ordinal": index, "source": "reference_video", "source_ordinal": index}
        for index, _ in enumerate(refs.get("videos", ()), 1)
    ]
    audios: list[dict[str, Any]] = []
    for source_ordinal, video in enumerate(refs.get("videos", ()), 1):
        if video.get("has_audio"):
            audios.append({
                "ordinal": len(audios) + 1,
                "source": "reference_video_audio",
                "source_ordinal": source_ordinal,
            })
    for source_ordinal, _ in enumerate(refs.get("audios", ()), 1):
        audios.append({
            "ordinal": len(audios) + 1,
            "source": "standalone_reference_audio",
            "source_ordinal": source_ordinal,
        })
    return {"pictures": pictures, "videos": videos, "audios": audios}


def build_request(
    prompt: str,
    *,
    duration_seconds: float | str = DEFAULT_DURATION_SECONDS,
    reference_images: Sequence[Path] = (),
    reference_videos: Sequence[Path] = (),
    reference_audios: Sequence[Path] = (),
) -> dict[str, Any]:
    if not isinstance(prompt, str):
        raise H3ContractError("prompt must be text")
    text = prompt.strip()
    if not text or "\x00" in text:
        raise H3ContractError("prompt must be non-empty and must not contain NUL")
    refs = {
        "images": _references(reference_images, "image"),
        "videos": _references(reference_videos, "video"),
        "audios": _references(reference_audios, "audio"),
    }
    if not any(refs.values()):
        raise H3ContractError("Ref2VA requires at least one image, video, or audio reference")
    _validate_reference_limits(refs)
    timing = duration_frame_contract(duration_seconds)
    validate_ref2va_prompt(
        text,
        refs,
        effective_duration_seconds=float(timing["duration_seconds"]),
    )
    return {
        "schema": SCHEMA,
        "prompt": text,
        "references": refs,
        "prompt_media_map": prompt_media_map(refs),
        **timing,
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "steps": STEPS,
        "sampler": SAMPLER,
        "audio_mode": "native",
    }


def request_id(request: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(request).encode("utf-8")).hexdigest()


def transport_references(
    request: Mapping[str, Any], *, images: Sequence[Path], videos: Sequence[Path], audios: Sequence[Path]
) -> list[dict[str, Any]]:
    """Create the non-canonical byte transport only after CPU admission succeeds."""
    refs = request.get("references")
    if not isinstance(refs, Mapping):
        raise H3ContractError("request references are missing or invalid")
    _validate_reference_limits(refs)
    if sum(len(paths) for paths in (images, videos, audios)) > MAX_REFERENCE_FILES:
        raise H3ContractError("reference transport exceeds the file count limit")
    supplied = {"images": images, "videos": videos, "audios": audios}
    output: list[dict[str, Any]] = []
    total_bytes = 0
    for category, paths in supplied.items():
        descriptors = refs.get(category)
        if not isinstance(descriptors, Sequence) or len(descriptors) != len(paths):
            raise H3ContractError(f"{category} transport count does not match the admitted request")
        kind = {"images": "image", "videos": "video", "audios": "audio"}[category]
        for descriptor, path in zip(descriptors, paths):
            path = Path(path)
            payload = path.read_bytes()
            if len(payload) != int(descriptor["size_bytes"]):
                raise H3ContractError(f"{category} transport size does not match the admitted request")
            if hashlib.sha256(payload).hexdigest() != descriptor["sha256"]:
                raise H3ContractError(f"{category} transport digest does not match the admitted request")
            total_bytes += len(payload)
            output.append({**descriptor, "kind": kind, "data_base64": base64.b64encode(payload).decode("ascii")})
    if total_bytes > MAX_REFERENCE_BYTES_TOTAL:
        raise H3ContractError("reference transport exceeds the total byte limit")
    return output


def load_graph() -> dict[str, Any]:
    try:
        graph = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise H3ContractError("single Ref2VA production graph is missing or invalid") from exc
    if not isinstance(graph, dict):
        raise H3ContractError("graph must be an object")
    return graph


def validate_graph(graph: Mapping[str, Any]) -> None:
    expected = {
        "1": "UNETLoader", "2": "CLIPLoader", "3": "VAELoader", "4": "VAELoader",
        "5": "LoraLoaderBypassModelOnly", "6": "LoadImage", "7": "LoadVideo",
        "8": "GetVideoComponents", "9": "LoadAudio", "10": "MiniMaxH3AudioConditioningT8",
        "11": "MiniMaxH3DualClockSamplerT8", "12": "RandomNoise", "13": "BasicGuider",
        "14": "SamplerCustomAdvanced", "15": "MiniMaxH3AVDecodeT8", "16": "CreateVideo",
        "17": "SaveVideo", "18": "LoraLoaderModelOnly",
    }
    actual = {key: node.get("class_type") for key, node in graph.items() if isinstance(node, Mapping)}
    if actual != expected:
        raise H3ContractError("graph topology is not the fixed Ref2VA production graph")
    nodes = list(graph.values())
    save_nodes = [node for node in nodes if isinstance(node, Mapping) and node.get("class_type") == "SaveVideo"]
    if len(save_nodes) != 1:
        raise H3ContractError("graph must have exactly one SaveVideo")
    save_inputs = save_nodes[0].get("inputs", {})
    if save_inputs.get("format") != "auto" or save_inputs.get("codec") != "auto":
        raise H3ContractError("SaveVideo must use format=auto and codec=auto")
    sampler_nodes = [node for node in nodes if isinstance(node, Mapping) and node.get("class_type") == "MiniMaxH3DualClockSamplerT8"]
    if len(sampler_nodes) != 1 or sampler_nodes[0].get("inputs", {}).get("steps") != STEPS:
        raise H3ContractError("production graph must use exactly 6 steps")
    sampler = sampler_nodes[0]["inputs"]
    if sampler.get("shift_video") != 12.0 or sampler.get("shift_audio") != 3.0:
        raise H3ContractError("production graph must use dual clock shifts 12/3")
    conditioning = graph["10"]["inputs"]
    if (
        (conditioning.get("width"), conditioning.get("height")) != (WIDTH, HEIGHT)
        or conditioning.get("length") != GENERATION_FRAMES
        or conditioning.get("task_type") != "Ref2VA"
        or conditioning.get("audio_mode") != "native"
    ):
        raise H3ContractError("Ref2VA conditioning dimensions or native audio policy changed")
    if graph["1"]["inputs"].get("unet_name") != HYBRID_MODEL_SOURCE_PATH:
        raise H3ContractError("graph must use the non-pruned hybrid Ref2VA model")
    lora = graph["5"]["inputs"]
    if lora.get("lora_name") != "minimax_h3_turbo_4步加速ema_comfyui.safetensors" or lora.get("strength_model") != 1.0:
        raise H3ContractError("graph must use the pinned EMA Turbo LoRA at strength 1")
    mystic = graph["18"]["inputs"]
    if (
        mystic.get("model") != ["5", 0]
        or mystic.get("lora_name") != MYSTIC_LORA_FILENAME
        or mystic.get("strength_model") != MYSTIC_LORA_STRENGTH
    ):
        raise H3ContractError("graph must stack the MysticXXX V1 adapter on the EMA Turbo LoRA")
    if sampler.get("model") != ["18", 0]:
        raise H3ContractError("sampler must consume the stacked adapter chain")
    if graph["12"]["inputs"].get("noise_seed") != 0:
        raise H3ContractError("graph must keep the fixed zero noise seed")
    if graph["16"]["inputs"].get("bit_depth") != "8":
        raise H3ContractError("CreateVideo bit_depth must remain 8")


def materialize_graph(
    request: Mapping[str, Any], reference_filenames: Mapping[str, Sequence[str]]
) -> dict[str, Any]:
    """Bind the fixed graph to admitted media without changing its model policy."""
    graph = copy.deepcopy(load_graph())
    graph["10"]["inputs"]["prompt"] = request["prompt"]
    graph["10"]["inputs"]["width"] = int(request.get("width", WIDTH))
    graph["10"]["inputs"]["height"] = int(request.get("height", HEIGHT))
    graph["10"]["inputs"]["length"] = int(request.get("generation_frames", GENERATION_FRAMES))
    graph["11"]["inputs"]["steps"] = int(request.get("steps", STEPS))
    graph["17"]["inputs"]["filename_prefix"] = (
        f"dsh_novel_h3_turbo{int(request.get('steps', STEPS))}_{request_id(request)[:16]}"
    )
    filenames = {kind: list(reference_filenames.get(kind, ())) for kind in ("image", "video", "audio")}
    for index, filename in enumerate(filenames["image"]):
        node_id = "6" if index == 0 else str(100 + index)
        if index:
            graph[node_id] = {"class_type": "LoadImage", "inputs": {}}
        graph[node_id]["inputs"]["image"] = filename
        graph["10"]["inputs"][f"ref_images.ref_image_{index}"] = [node_id, 0]
    if not filenames["image"]:
        graph.pop("6", None)
    for index in range(MAX_REFERENCE_IMAGES):
        if index >= len(filenames["image"]):
            graph["10"]["inputs"].pop(f"ref_images.ref_image_{index}", None)

    for index, filename in enumerate(filenames["video"]):
        loader_id = "7" if index == 0 else str(200 + index * 2)
        components_id = "8" if index == 0 else str(201 + index * 2)
        if index:
            graph[loader_id] = {"class_type": "LoadVideo", "inputs": {}}
            graph[components_id] = {"class_type": "GetVideoComponents", "inputs": {"video": [loader_id, 0]}}
        graph[loader_id]["inputs"]["file"] = filename
        graph["10"]["inputs"][f"ref_videos.ref_video_{index}"] = [components_id, 0]
        graph["10"]["inputs"][f"ref_video_audios.ref_video_audio_{index}"] = [components_id, 1]
    if not filenames["video"]:
        graph.pop("7", None)
        graph.pop("8", None)
    for index in range(MAX_REFERENCE_VIDEOS):
        if index >= len(filenames["video"]):
            graph["10"]["inputs"].pop(f"ref_videos.ref_video_{index}", None)
            graph["10"]["inputs"].pop(f"ref_video_audios.ref_video_audio_{index}", None)

    for index, filename in enumerate(filenames["audio"]):
        node_id = "9" if index == 0 else str(300 + index)
        if index:
            graph[node_id] = {"class_type": "LoadAudio", "inputs": {}}
        graph[node_id]["inputs"]["audio"] = filename
        graph["10"]["inputs"][f"ref_audios.ref_audio_{index}"] = [node_id, 0]
    if not filenames["audio"]:
        graph.pop("9", None)
    for index in range(MAX_REFERENCE_AUDIOS):
        if index >= len(filenames["audio"]):
            graph["10"]["inputs"].pop(f"ref_audios.ref_audio_{index}", None)
    # The static graph is validated before optional reference loaders are pruned.
    return graph


def validate_manifest() -> None:
    try:
        manifest = json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise H3ContractError("model manifest is missing or invalid") from exc
    if not isinstance(manifest, Mapping) or manifest.get("schema") != MODEL_MANIFEST_SCHEMA:
        raise H3ContractError("model manifest schema is not the pinned DSH-Novel Turbo6 schema")
    if manifest.get("repo") != MODEL_REPOSITORY or manifest.get("immutable_revision") != MODEL_REVISION:
        raise H3ContractError("model manifest repository or revision is not pinned")
    t8 = manifest.get("t8")
    if not isinstance(t8, Mapping) or t8.get("repo") != T8_REPOSITORY or t8.get("commit") != T8_COMMIT:
        raise H3ContractError("T8 repository or commit is not pinned")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise H3ContractError("model manifest artifacts are invalid")
    roles = {item.get("role"): item for item in artifacts if isinstance(item, dict)}
    required = {
        "ref2va_hybrid_nonpruned", "clip_nvfp4", "video_vae", "audio_vae",
        "turbo_lora_ema", "mystic_lora_v1",
    }
    if set(roles) != required or len(roles) != len(artifacts):
        raise H3ContractError("manifest must contain only the fixed Ref2VA production roles")
    for role in ("clip_nvfp4", "video_vae", "audio_vae"):
        item = roles[role]
        if item.get("repo") != MODEL_REPOSITORY or item.get("revision") != MODEL_REVISION:
            raise H3ContractError(f"manifest artifact is not pinned to the H3 model revision: {role}")
    base = roles["ref2va_hybrid_nonpruned"]
    if (
        base.get("repo") != HYBRID_MODEL_REPOSITORY
        or base.get("revision") != HYBRID_MODEL_REVISION
        or base.get("source_path") != HYBRID_MODEL_SOURCE_PATH
        or base.get("path") != HYBRID_MODEL_PATH
        or base.get("size_bytes") != HYBRID_MODEL_SIZE_BYTES
        or base.get("sha256") != HYBRID_MODEL_SHA256
    ):
        raise H3ContractError("hybrid base-model identity is not pinned")
    lora = roles["turbo_lora_ema"]
    if (
        lora.get("repo") != TURBO_LORA_REPOSITORY
        or lora.get("revision") != TURBO_LORA_REVISION
        or lora.get("source_path") != TURBO_LORA_SOURCE_PATH
        or lora.get("strength_model") != 1.0
    ):
        raise H3ContractError("EMA LoRA repository, revision, source, or strength is not pinned")
    mystic = roles["mystic_lora_v1"]
    if (
        mystic.get("source_url") != MYSTIC_LORA_SOURCE_URL
        or mystic.get("path") != MYSTIC_LORA_PATH
        or mystic.get("size_bytes") != MYSTIC_LORA_SIZE_BYTES
        or mystic.get("sha256") != MYSTIC_LORA_SHA256
        or mystic.get("strength_model") != MYSTIC_LORA_STRENGTH
    ):
        raise H3ContractError("MysticXXX V1 adapter identity is not pinned")
    for role, item in roles.items():
        if (
            not isinstance(item.get("path"), str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", str(item.get("sha256")))
            or not isinstance(item.get("size_bytes"), int)
            or item["size_bytes"] <= 0
        ):
            raise H3ContractError(f"manifest artifact is missing valid size/SHA-256: {role}")


def cpu_preflight(request: Mapping[str, Any]) -> dict[str, Any]:
    profiles = {
        CANONICAL_SCHEMA: (STEPS, MAX_ATTEMPTS, MAX_EXECUTION_SECONDS_PER_ATTEMPT),
        LEGACY_SCHEMA: (STEPS, MAX_ATTEMPTS, MAX_EXECUTION_SECONDS_PER_ATTEMPT),
    }
    req_schema = request.get("schema")
    profile = profiles.get(req_schema)
    if profile is None:
        raise H3ContractError("request is not an admitted Ref2VA request")
    expected_steps, max_attempts, max_execution_seconds = profile
    if request.get("steps") != expected_steps:
        raise H3ContractError("request step count does not match its fixed Ref2VA profile")
    timing = duration_frame_contract(request.get("requested_duration_seconds", request.get("duration_seconds")))
    if (
        request.get("width"), request.get("height"), request.get("fps"),
        request.get("requested_duration_seconds"), request.get("duration_seconds"),
        request.get("generation_frames"), request.get("output_frames"),
    ) != (
        WIDTH, HEIGHT, FPS,
        timing["requested_duration_seconds"], timing["duration_seconds"],
        timing["generation_frames"], timing["output_frames"],
    ):
        raise H3ContractError("request duration/frame contract does not match its admitted Ref2VA profile")
    if request.get("sampler") != SAMPLER or request.get("audio_mode") != "native":
        raise H3ContractError("request sampler or native audio policy changed")
    refs = request.get("references")
    if not isinstance(refs, Mapping):
        raise H3ContractError("request references are missing or invalid")
    _validate_reference_limits(refs)
    if request.get("prompt_media_map") != prompt_media_map(refs):
        raise H3ContractError("request prompt media map does not match its ordered references")
    validate_ref2va_prompt(
        str(request.get("prompt", "")),
        refs,
        effective_duration_seconds=float(timing["duration_seconds"]),
    )
    validate_manifest()
    graph = load_graph()
    validate_graph(graph)
    preflight_schema = (
        LEGACY_PREFLIGHT_SCHEMA
        if req_schema == LEGACY_SCHEMA
        else CANONICAL_PREFLIGHT_SCHEMA
    )
    return {
        "schema": preflight_schema,
        "request_id": request_id(request),
        "request": request,
        "graph_sha256": hashlib.sha256(canonical_json(graph).encode()).hexdigest(),
        "max_attempts": max_attempts,
        "budget_usd": BUDGET_USD,
        "stop_readback_reserve_usd": STOP_READBACK_RESERVE_USD,
        "highest_composite_hourly_rate_usd": max(GPU_RATE_USD_PER_HOUR.values()),
        "admission_rate_usd_per_hour": ADMISSION_RATE_USD_PER_HOUR,
        "max_execution_seconds_per_attempt": max_execution_seconds,
        "gpu_placement": list(GPU_PLACEMENT),
        "runtime_release": runtime_release(),
        "dry_run_writes": False,
    }
