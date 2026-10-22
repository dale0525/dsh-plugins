"""Private Modal worker for the sole MiniMax-H3 Ref2VA production route."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Mapping

from modal_h3_contract import (
    ADMISSION_RATE_USD_PER_HOUR, APP_NAME, BOOTSTRAP_RECEIPT_NAME, BOOTSTRAP_RECEIPT_SCHEMA,
    COMFY_COMMIT, CUDA_IMAGE, GPU_MIN_MEMORY_MIB,
    GPU_PLACEMENT, GPU_PRICE_RETRIEVED_AT, GPU_RATE_USD_PER_HOUR,
    GRAPH_PATH, LEGACY_BOOTSTRAP_RECEIPT_NAME,
    MAX_ATTEMPTS, MAX_COST_USD_PER_ATTEMPT,
    MAX_EXECUTION_SECONDS_PER_ATTEMPT, MODEL_MANIFEST_PATH,
    REPORT_SCHEMA, FAILURE_SCHEMA, validate_transport_references,
    MODEL_VOLUME_NAME,
    STATE_VOLUME_NAME,
    T8_COMMIT, T8_REPOSITORY, TORCHAUDIO_VERSION, TORCHVISION_VERSION,
    TORCH_INDEX, TORCH_VERSION,
    cpu_preflight, expected_bootstrap_receipt, materialize_graph, runtime_release, validate_bootstrap_receipt, validate_graph,
)

try:
    import modal  # type: ignore
except ImportError:  # local CPU tests deliberately do not install Modal
    modal = None  # type: ignore[assignment]

COMFY_ROOT = Path("/opt/ComfyUI")
MODEL_ROOT = Path("/models/models")
STATE_ROOT = Path("/state")


def _normalized_gpu_name(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def detected_gpu_facts() -> dict[str, Any]:
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        check=False, capture_output=True, text=True,
    )
    name, memory_mib = "unknown", None
    if result.returncode == 0 and result.stdout.strip():
        parts = [part.strip() for part in result.stdout.splitlines()[0].split(",", 1)]
        name = parts[0]
        try:
            memory_mib = int(parts[1])
        except (IndexError, ValueError):
            pass
    normalized = _normalized_gpu_name(name)
    aliases = {
        "B200": "B200", "RTXPRO6000": "RTX-PRO-6000",
        "A100": "A100-80GB", "L40S": "L40S",
    }
    sku = next((value for marker, value in aliases.items() if marker in normalized), None)
    rate = GPU_RATE_USD_PER_HOUR.get(sku or "")
    minimum = GPU_MIN_MEMORY_MIB.get(sku or "")
    if sku not in GPU_PLACEMENT or memory_mib is None or minimum is None or memory_mib < minimum:
        raise RuntimeError(f"allocated GPU is outside the admitted fallback/memory policy: {name}, {memory_mib} MiB")
    return {
        "gpu_name": name, "gpu_sku": sku, "gpu_memory_mib": memory_mib,
        "configured_rate_usd_per_hour": rate,
        "configured_rate_usd_per_second": rate / 3600 if rate is not None else None,
        "price_retrieved_at": GPU_PRICE_RETRIEVED_AT,
    }


def _gpu_sample() -> dict[str, Any] | None:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=driver_version,memory.total,memory.used,memory.free,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode or not result.stdout.strip():
        return None
    values = [item.strip() for item in result.stdout.splitlines()[0].split(",")]
    if len(values) != 5:
        return None
    try:
        return {
            "monotonic_seconds": time.monotonic(),
            "driver_version": values[0],
            "memory_total_mib": int(values[1]),
            "memory_used_mib": int(values[2]),
            "memory_free_mib": int(values[3]),
            "utilization_gpu_percent": int(values[4]),
        }
    except ValueError:
        return None


class _GpuTelemetry:
    def __init__(self, interval_seconds: float = 1.0) -> None:
        self.interval_seconds = interval_seconds
        self.samples: list[dict[str, Any]] = []
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("GPU telemetry was already started")

        def collect() -> None:
            while not self._stop_event.is_set():
                sample = _gpu_sample()
                if sample is not None:
                    self.samples.append(sample)
                self._stop_event.wait(self.interval_seconds)

        self._thread = threading.Thread(target=collect, name="h3-gpu-telemetry", daemon=True)
        self._thread.start()

    def stop(self) -> dict[str, Any]:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(2.0, self.interval_seconds * 2))
        return self.summary()

    def summary(self) -> dict[str, Any]:
        if not self.samples:
            return {"sample_count": 0, "interval_seconds": self.interval_seconds}
        return {
            "sample_count": len(self.samples),
            "interval_seconds": self.interval_seconds,
            "driver_version": self.samples[0]["driver_version"],
            "memory_total_mib": max(item["memory_total_mib"] for item in self.samples),
            "peak_memory_used_mib": max(item["memory_used_mib"] for item in self.samples),
            "minimum_memory_free_mib": min(item["memory_free_mib"] for item in self.samples),
            "peak_utilization_gpu_percent": max(item["utilization_gpu_percent"] for item in self.samples),
            "average_utilization_gpu_percent": round(
                sum(item["utilization_gpu_percent"] for item in self.samples) / len(self.samples), 3
            ),
        }


def _phase_durations(marks: Mapping[str, float]) -> dict[str, float | None]:
    pairs = {
        "preflight_seconds": ("worker_started", "preflight_complete"),
        "reference_preparation_seconds": ("preflight_complete", "references_ready"),
        "comfy_startup_seconds": ("references_ready", "comfy_ready"),
        "model_reference_preprocessing_seconds": ("prompt_submitted", "sampling_started"),
        "sampling_seconds": ("sampling_started", "vae_decode_started"),
        "vae_decode_seconds": ("vae_decode_started", "video_create_started"),
        "video_create_seconds": ("video_create_started", "video_save_started"),
        "video_save_seconds": ("video_save_started", "generation_complete"),
        "generation_seconds": ("prompt_submitted", "generation_complete"),
        "output_finalize_seconds": ("generation_complete", "output_durable"),
        "total_seconds": ("worker_started", "output_durable"),
    }
    output: dict[str, float | None] = {}
    for name, (start, end) in pairs.items():
        output[name] = round(marks[end] - marks[start], 3) if start in marks and end in marks else None
    return output


def _gpu_telemetry_by_phase(
    samples: list[dict[str, Any]], marks: Mapping[str, float]
) -> dict[str, dict[str, Any]]:
    windows = {
        "preflight": ("worker_started", "preflight_complete"),
        "reference_preparation": ("preflight_complete", "references_ready"),
        "comfy_startup": ("references_ready", "comfy_ready"),
        "model_reference_preprocessing": ("prompt_submitted", "sampling_started"),
        "sampling": ("sampling_started", "vae_decode_started"),
        "vae_decode": ("vae_decode_started", "video_create_started"),
        "video_create_and_save": ("video_create_started", "generation_complete"),
    }
    output: dict[str, dict[str, Any]] = {}
    for name, (start_name, end_name) in windows.items():
        if start_name not in marks or end_name not in marks:
            continue
        start, end = marks[start_name], marks[end_name]
        selected = [
            item for item in samples
            if start <= float(item["monotonic_seconds"]) <= end
        ]
        if not selected:
            continue
        output[name] = {
            "sample_count": len(selected),
            "peak_memory_used_mib": max(item["memory_used_mib"] for item in selected),
            "minimum_memory_free_mib": min(item["memory_free_mib"] for item in selected),
            "peak_utilization_gpu_percent": max(item["utilization_gpu_percent"] for item in selected),
            "average_utilization_gpu_percent": round(
                sum(item["utilization_gpu_percent"] for item in selected) / len(selected), 3
            ),
        }
    return output


def _estimated_gpu_cost(elapsed_seconds: float, gpu_facts: Mapping[str, Any]) -> float:
    rate = gpu_facts.get("configured_rate_usd_per_second")
    if not isinstance(rate, (int, float)) or rate <= 0:
        raise RuntimeError("allocated GPU has no configured Modal price")
    return round(elapsed_seconds * float(rate), 6)


def _runtime_facts() -> dict[str, Any]:
    import torch
    import torchaudio
    import torchvision

    facts = {
        "torch": str(torch.__version__),
        "torchvision": str(torchvision.__version__),
        "torchaudio": str(torchaudio.__version__),
        "torch_cuda": str(torch.version.cuda),
        "cuda_image": CUDA_IMAGE,
        "comfy_commit": subprocess.run(
            ["git", "-C", str(COMFY_ROOT), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip(),
        "t8_commit": subprocess.run(
            ["git", "-C", str(COMFY_ROOT / "custom_nodes/ComfyUI-MiniMax-H3-Turbo"), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip(),
    }
    expected = {
        "torch": TORCH_VERSION,
        "torchvision": TORCHVISION_VERSION,
        "torchaudio": TORCHAUDIO_VERSION,
        "torch_cuda": "13.0",
        "comfy_commit": COMFY_COMMIT,
        "t8_commit": T8_COMMIT,
    }
    mismatches = {
        key: {"expected": value, "actual": facts.get(key)}
        for key, value in expected.items() if facts.get(key) != value
    }
    if mismatches:
        raise RuntimeError("worker runtime does not match the pinned release: " + json.dumps(mismatches, sort_keys=True))
    return facts


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _manifest() -> dict[str, Any]:
    return json.loads(MODEL_MANIFEST_PATH.read_text(encoding="utf-8"))


_expected_bootstrap_receipt = expected_bootstrap_receipt


def validate_bootstrap_receipt_fast() -> dict[str, Any]:
    """Trust the last full verification receipt, then stat files without rehashing them."""
    expected = _expected_bootstrap_receipt(_manifest())
    receipt_path = MODEL_ROOT / BOOTSTRAP_RECEIPT_NAME
    legacy_receipt_path = MODEL_ROOT / LEGACY_BOOTSTRAP_RECEIPT_NAME
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        try:
            receipt = json.loads(legacy_receipt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("model verification receipt is missing or invalid; run bootstrap maintenance") from exc
    try:
        validate_bootstrap_receipt(receipt)
    except Exception as exc:
        raise RuntimeError("model verification receipt does not match the pinned release; run bootstrap maintenance") from exc
    for item in expected["verified"]:
        destination = MODEL_ROOT / item["path"]
        if not destination.is_file() or destination.stat().st_size != item["size_bytes"]:
            raise RuntimeError(f"model file is missing or has the wrong size: {item['role']}; run bootstrap maintenance")
    return {"schema": BOOTSTRAP_RECEIPT_SCHEMA, "valid": True, "verification": "receipt-and-size"}


def _request_attempt_count(attempts_path: Path, request_id: str, release_fingerprint: str) -> int:
    if not attempts_path.exists():
        return 0
    count = 0
    for line_number, line in enumerate(attempts_path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"attempt ledger is invalid at line {line_number}") from exc
        if not isinstance(item, Mapping) or "request_id" not in item:
            raise RuntimeError(f"attempt ledger is invalid at line {line_number}")
        # Legacy rows deliberately do not consume attempts for a new immutable release.
        if item["request_id"] == request_id and item.get("runtime_release_fingerprint") == release_fingerprint:
            count += 1
    return count


def _prepare_comfy_paths(input_root: Path, output_root: Path) -> None:
    models_link = COMFY_ROOT / "models"
    if models_link.is_symlink() or models_link.is_file():
        models_link.unlink()
    elif models_link.exists():
        shutil.rmtree(models_link)
    models_link.symlink_to(MODEL_ROOT, target_is_directory=True)
    input_root.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)


def _write_references(
    envelope: Mapping[str, Any], input_root: Path, *, decoded: list[Mapping[str, Any]] | None = None,
) -> dict[str, list[str]]:
    request = envelope.get("request")
    if not isinstance(request, Mapping):
        raise RuntimeError("transport request is missing")
    if decoded is None:
        decoded = validate_transport_references(request, envelope.get("references"))
    filenames: dict[str, list[str]] = {"image": [], "video": [], "audio": []}
    for index, item in enumerate(decoded):
        kind = str(item["kind"])
        suffix = {"image": ".png", "video": ".mp4", "audio": ".mp3"}[kind]
        filename = f"h3-{envelope['request_id']}-{kind}-{index}{suffix}"
        (input_root / filename).write_bytes(item["payload"])
        filenames[kind].append(filename)
    return filenames


def _request_json(url: str, *, payload: Mapping[str, Any] | None = None, timeout: float = 30) -> Any:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def _start_comfy(input_root: Path, output_root: Path, *, cpu: bool) -> subprocess.Popen[bytes]:
    command = [
        "python", str(COMFY_ROOT / "main.py"), "--listen", "127.0.0.1", "--port", "8188",
        "--input-directory", str(input_root), "--output-directory", str(output_root),
    ]
    if cpu:
        command.append("--cpu")
    log_path = output_root.parent / "comfy.log"
    log_handle = log_path.open("wb")
    process = subprocess.Popen(command, cwd=COMFY_ROOT, stdout=log_handle, stderr=subprocess.STDOUT)
    process._h3_log_handle = log_handle  # type: ignore[attr-defined]
    process._h3_log_path = log_path  # type: ignore[attr-defined]
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if process.poll() is not None:
            log_handle.close()
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise RuntimeError("ComfyUI exited before becoming ready: " + tail)
        try:
            _request_json("http://127.0.0.1:8188/system_stats", timeout=2)
            return process
        except (OSError, ValueError):
            time.sleep(1)
    process.terminate()
    raise RuntimeError("ComfyUI did not become ready")


def _stop(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
    handle = getattr(process, "_h3_log_handle", None)
    if handle is not None and not handle.closed:
        handle.close()


def _validate_live_node_set(object_info: Mapping[str, Any], graph: Mapping[str, Any]) -> None:
    missing = sorted({node["class_type"] for node in graph.values()} - set(object_info))
    if missing:
        raise RuntimeError("pinned Comfy/T8 runtime is missing graph nodes: " + ", ".join(missing))
    for node in graph.values():
        node_info = object_info[node["class_type"]]
        declared = set((node_info.get("input") or {}).get("required") or {}) | set((node_info.get("input") or {}).get("optional") or {})
        for input_name in node["inputs"]:
            base = input_name.split(".", 1)[0]
            if input_name not in declared and base not in declared:
                raise RuntimeError(f"live node contract rejects {node['class_type']}.{input_name}")


def _wait_for_prompt(graph: Mapping[str, Any], deadline: float, marks: dict[str, float]) -> tuple[str, Mapping[str, Any]]:
    import websocket

    client_id = uuid.uuid4().hex
    socket = websocket.create_connection(f"ws://127.0.0.1:8188/ws?clientId={client_id}", timeout=10)
    try:
        response = _request_json(
            "http://127.0.0.1:8188/prompt",
            payload={"prompt": graph, "client_id": client_id},
            timeout=30,
        )
        prompt_id = str(response["prompt_id"])
        marks["prompt_submitted"] = time.monotonic()
        node_marks = {
            "14": "sampling_started",
            "15": "vae_decode_started",
            "16": "video_create_started",
            "17": "video_save_started",
        }
        while time.monotonic() < deadline:
            socket.settimeout(max(0.1, min(10.0, deadline - time.monotonic())))
            try:
                message = socket.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if isinstance(message, bytes):
                continue
            event = json.loads(message)
            data = event.get("data", {}) if isinstance(event, Mapping) else {}
            if data.get("prompt_id") != prompt_id:
                continue
            if event.get("type") == "execution_error":
                raise RuntimeError("ComfyUI reported an execution error")
            if event.get("type") == "executing":
                node = data.get("node")
                if str(node) in node_marks:
                    marks.setdefault(node_marks[str(node)], time.monotonic())
                if node is None:
                    marks["generation_complete"] = time.monotonic()
                    break
        history = _request_json(f"http://127.0.0.1:8188/history/{prompt_id}", timeout=30)
        return prompt_id, history
    finally:
        socket.close()


if modal is not None:
    app = modal.App(APP_NAME)
    model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
    state_volume = modal.Volume.from_name(STATE_VOLUME_NAME, create_if_missing=False)
    runtime_image = (
        modal.Image.from_registry(CUDA_IMAGE, add_python="3.11")
        .apt_install("git", "git-lfs", "ffmpeg", "build-essential", "ca-certificates", "libgl1", "libglib2.0-0", "libsndfile1")
        .run_commands(
            "git lfs install --system",
            f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_ROOT}",
            f"git -C {COMFY_ROOT} fetch --depth 1 origin {COMFY_COMMIT}",
            f"git -C {COMFY_ROOT} checkout {COMFY_COMMIT}",
            f"git clone https://github.com/{T8_REPOSITORY}.git {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo",
            f"git -C {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo fetch --depth 1 origin {T8_COMMIT}",
            f"git -C {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo checkout {T8_COMMIT}",
            f"python -m pip install --no-cache-dir --index-url {TORCH_INDEX} torch=={TORCH_VERSION} torchvision=={TORCHVISION_VERSION} torchaudio=={TORCHAUDIO_VERSION}",
            f"python -m pip install --no-cache-dir -r {COMFY_ROOT}/requirements.txt huggingface_hub websocket-client",
            f"if [ -f {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo/requirements.txt ]; then python -m pip install --no-cache-dir -r {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo/requirements.txt; fi",
            f"python -c \"import torch, torchvision, torchaudio; assert torch.__version__ == '{TORCH_VERSION}'; assert torchvision.__version__ == '{TORCHVISION_VERSION}'; assert torchaudio.__version__ == '{TORCHAUDIO_VERSION}'; assert torch.version.cuda == '13.0'\"",
            f"test \"$(git -C {COMFY_ROOT} rev-parse HEAD)\" = {COMFY_COMMIT}",
            f"test \"$(git -C {COMFY_ROOT}/custom_nodes/ComfyUI-MiniMax-H3-Turbo rev-parse HEAD)\" = {T8_COMMIT}",
        )
    )
    image = (
        runtime_image
        .env({"DSH_NOVEL_H3_ASSET_ROOT": "/root/assets", "PYTHONPATH": "/root:/opt/ComfyUI"})
        .add_local_file(str(Path(__file__).with_name("modal_h3_contract.py")), "/root/modal_h3_contract.py")
        .add_local_file(str(GRAPH_PATH), "/root/assets/minimax_h3_ref2va_turbo6_api.json")
        .add_local_file(str(MODEL_MANIFEST_PATH), "/root/assets/model-manifest.json")
    )
    qualification_image = (
        runtime_image
        .run_commands("python -m pip uninstall -y triton")
        .env({"DSH_NOVEL_H3_ASSET_ROOT": "/root/assets", "PYTHONPATH": "/root:/opt/ComfyUI"})
        .add_local_file(str(Path(__file__).with_name("modal_h3_contract.py")), "/root/modal_h3_contract.py")
        .add_local_file(str(GRAPH_PATH), "/root/assets/minimax_h3_ref2va_turbo6_api.json")
        .add_local_file(str(MODEL_MANIFEST_PATH), "/root/assets/model-manifest.json")
    )

    def _download_url(url: str, destination: Path) -> None:
        """Stream a direct-URL artifact to disk, following Civitai's CDN redirect."""
        request = urllib.request.Request(url, headers={"User-Agent": "dsh-novel-h3-bootstrap/1"})
        with urllib.request.urlopen(request, timeout=1800) as response:
            if response.status != 200:
                raise RuntimeError(f"artifact download failed with HTTP {response.status}")
            with destination.open("wb") as handle:
                shutil.copyfileobj(response, handle, length=1 << 22)

    @app.function(image=image, gpu=None, volumes={"/models": model_volume}, timeout=21600, max_containers=1)
    def bootstrap() -> dict[str, Any]:
        from huggingface_hub import hf_hub_download
        manifest = _manifest()
        verified: list[dict[str, Any]] = []
        for item in manifest["artifacts"]:
            destination = MODEL_ROOT / item["path"]
            digest = None
            if destination.is_file() and destination.stat().st_size == item["size_bytes"]:
                digest = _sha256(destination)
            if digest != item["sha256"]:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.unlink(missing_ok=True)
                if item.get("source_url"):
                    # MysticXXX V1 is published on Civitai only; no HuggingFace mirror carries it.
                    _download_url(item["source_url"], destination)
                else:
                    downloaded = Path(hf_hub_download(
                        repo_id=item["repo"], filename=item.get("source_path", item["path"]), revision=item["revision"],
                        local_dir=MODEL_ROOT,
                    ))
                    if downloaded != destination:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(downloaded, destination)
                digest = _sha256(destination) if destination.is_file() and destination.stat().st_size == item["size_bytes"] else None
            if digest != item["sha256"]:
                raise RuntimeError(f"model verification failed: {item['role']}")
            verified.append({"role": item["role"], "path": item["path"], "sha256": item["sha256"], "size_bytes": item["size_bytes"]})
        receipt = _expected_bootstrap_receipt(manifest)
        if receipt["verified"] != verified:
            raise RuntimeError("bootstrap verification did not cover the pinned manifest exactly")
        receipt_path = MODEL_ROOT / BOOTSTRAP_RECEIPT_NAME
        receipt_path.write_text(json.dumps(receipt, sort_keys=True), encoding="utf-8")
        model_volume.commit()
        return receipt

    @app.function(image=qualification_image, gpu=None, volumes={"/models": model_volume}, timeout=900, max_containers=1)
    def qualify(envelope: Mapping[str, Any]) -> dict[str, Any]:
        preflight = cpu_preflight(envelope["request"])
        release = runtime_release()
        if envelope.get("request_id") != preflight["request_id"]:
            raise RuntimeError("qualification request_id does not match the canonical request")
        if envelope.get("runtime_release_fingerprint") != release["fingerprint"]:
            raise RuntimeError("qualification runtime release does not match the image")
        validate_bootstrap_receipt_fast()
        validate_graph(json.loads(Path("/root/assets/minimax_h3_ref2va_turbo6_api.json").read_text()))
        with tempfile.TemporaryDirectory(prefix="h3-qualification-") as temporary:
            root = Path(temporary)
            input_root, output_root = root / "input", root / "output"
            _prepare_comfy_paths(input_root, output_root)
            filenames = _write_references(envelope, input_root)
            graph = materialize_graph(envelope["request"], filenames)
            process = None
            try:
                process = _start_comfy(input_root, output_root, cpu=True)
                object_info = _request_json("http://127.0.0.1:8188/object_info", timeout=60)
                _validate_live_node_set(object_info, graph)
            finally:
                _stop(process)
        return {
            "schema": "dsh-novel.modal-h3.ref2va-turbo6.qualification.v1",
            "valid": True,
            "gpu_allocated": False,
            "runtime_release": release,
        }

    class _WorkerImplementation:
        def _run_impl(
            self,
            envelope: Mapping[str, Any],
            *,
            max_attempts: int,
            execution_limit: int,
            reserved_max_usd: float,
        ) -> dict[str, Any]:
            started = time.monotonic()
            worker_started_unix = time.time()
            marks = {"worker_started": started}
            request = envelope.get("request")
            if not isinstance(request, Mapping):
                raise RuntimeError("transport request is missing")
            request_schema = str(request.get("schema"))
            submitted = envelope.get("client_submitted_unix_seconds")
            cold_start_seconds = (
                max(0.0, worker_started_unix - float(submitted))
                if isinstance(submitted, (int, float)) else None
            )
            release = runtime_release()
            release_fingerprint = str(release["fingerprint"])
            preflight = cpu_preflight(request)
            if envelope.get("request_id") != preflight["request_id"]:
                raise RuntimeError("transport request_id does not match the canonical request")
            if envelope.get("runtime_release_fingerprint") != release_fingerprint:
                raise RuntimeError("transport runtime release does not match the worker image")
            validate_bootstrap_receipt_fast()
            # Decode and authenticate every reference before consuming an attempt.
            # The returned descriptors are reused by the GPU path below.
            decoded_references = validate_transport_references(request, envelope.get("references"))
            attempts_path = STATE_ROOT / "attempts.jsonl"
            attempts_path.parent.mkdir(parents=True, exist_ok=True)
            existing_count = _request_attempt_count(
                attempts_path,
                str(envelope["request_id"]),
                release_fingerprint,
            )
            if existing_count >= max_attempts:
                raise RuntimeError("the GPU attempt budget for this request and runtime release is exhausted")
            attempt_number = existing_count + 1
            with attempts_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "attempt": attempt_number,
                    "request_id": envelope["request_id"],
                    "runtime_release_fingerprint": release_fingerprint,
                    "request_schema": request_schema,
                    "gpu_placement": list(GPU_PLACEMENT),
                    "reserved_max_usd": reserved_max_usd,
                }, sort_keys=True) + "\n")
            state_volume.commit()
            facts: dict[str, Any] | None = None
            runtime: dict[str, Any] | None = None
            work: Path | None = None
            process = None
            telemetry = _GpuTelemetry(interval_seconds=1.0)
            telemetry.start()
            try:
                marks["preflight_complete"] = time.monotonic()
                facts = detected_gpu_facts()
                runtime = _runtime_facts()
                work = Path(tempfile.mkdtemp(prefix="h3-gpu-"))
                input_root, output_root = work / "input", work / "output"
                _prepare_comfy_paths(input_root, output_root)
                filenames = _write_references(envelope, input_root, decoded=decoded_references)
                graph = materialize_graph(envelope["request"], filenames)
                marks["references_ready"] = time.monotonic()
                prefix = graph["17"]["inputs"]["filename_prefix"]
                process = _start_comfy(input_root, output_root, cpu=False)
                marks["comfy_ready"] = time.monotonic()
                deadline = started + execution_limit - 45
                prompt_id, history = _wait_for_prompt(graph, deadline, marks)
                entry = history.get(prompt_id, {}) if isinstance(history, Mapping) else {}
                status = entry.get("status", {}) if isinstance(entry, Mapping) else {}
                if status.get("status_str") == "error":
                    raise RuntimeError("ComfyUI reported an execution error")
                if "generation_complete" not in marks:
                    raise RuntimeError("ComfyUI did not complete before the budget deadline")
                candidates = sorted(output_root.rglob(f"{prefix}*.mp4"), key=lambda path: path.stat().st_mtime_ns)
                if not candidates:
                    raise RuntimeError("SaveVideo did not produce the expected MP4 before the budget deadline")
                durable_root = (
                    STATE_ROOT / "outputs" / release_fingerprint /
                    str(envelope["request_id"]) / f"attempt-{attempt_number}"
                )
                durable_root.mkdir(parents=True, exist_ok=True)
                durable_video = durable_root / f"generated-{envelope['request']['generation_frames']}.mp4"
                shutil.copy2(candidates[-1], durable_video)
                marks["output_durable"] = time.monotonic()
                output_durable_unix = time.time()
                elapsed = time.monotonic() - started
                estimated_cost = _estimated_gpu_cost(elapsed, facts)
                telemetry_report = telemetry.stop()
                telemetry_by_phase = _gpu_telemetry_by_phase(telemetry.samples, marks)
                phases = _phase_durations(marks)
                generation_seconds = phases["generation_seconds"]
                observed_window_seconds = (
                    max(0.0, output_durable_unix - float(submitted))
                    if isinstance(submitted, (int, float)) else None
                )
                report = {
                    "schema": REPORT_SCHEMA,
                    "request_id": envelope["request_id"], "attempt": attempt_number,
                    "request_profile": {
                        "schema": request_schema,
                        "requested_duration_seconds": envelope["request"]["requested_duration_seconds"],
                        "duration_seconds": envelope["request"]["duration_seconds"],
                        "generation_frames": envelope["request"]["generation_frames"],
                        "output_frames": envelope["request"]["output_frames"],
                        "steps": envelope["request"]["steps"],
                        "reference_counts": {
                            category: len(envelope["request"]["references"].get(category, []))
                            for category in ("images", "videos", "audios")
                        },
                    },
                    "runtime_release": release,
                    "runtime": runtime,
                    "t8_commit": T8_COMMIT,
                    "gpu_candidates": list(GPU_PLACEMENT),
                    "gpu": facts,
                    "gpu_telemetry": telemetry_report,
                    "gpu_telemetry_by_phase": telemetry_by_phase,
                    "phase_durations": phases,
                    "elapsed_seconds": round(elapsed, 3), "estimated_gpu_cost_usd": estimated_cost,
                    "timing": {
                        "observed_cold_start_upper_bound_seconds": (
                            round(cold_start_seconds, 3) if cold_start_seconds is not None else None
                        ),
                        "worker_execution_seconds": round(elapsed, 3),
                        "actual_generation_seconds": generation_seconds,
                        "submission_to_output_seconds": (
                            round(observed_window_seconds, 3) if observed_window_seconds is not None else None
                        ),
                    },
                    "cost": {
                        "estimated_generation_gpu_usd": (
                            _estimated_gpu_cost(float(generation_seconds), facts)
                            if generation_seconds is not None else None
                        ),
                        "estimated_worker_execution_gpu_usd": estimated_cost,
                        "estimated_cold_start_gpu_upper_bound_usd": (
                            _estimated_gpu_cost(cold_start_seconds, facts)
                            if cold_start_seconds is not None else None
                        ),
                        "estimated_submission_to_output_gpu_upper_bound_usd": (
                            _estimated_gpu_cost(observed_window_seconds, facts)
                            if observed_window_seconds is not None else None
                        ),
                    },
                    "max_execution_seconds": execution_limit,
                    "admission_rate_usd_per_hour": ADMISSION_RATE_USD_PER_HOUR,
                    "durable_generated_video": str(durable_video),
                }
                (durable_root / "report.json").write_text(json.dumps(report, sort_keys=True), encoding="utf-8")
                state_volume.commit()
                return {"video_base64": base64.b64encode(durable_video.read_bytes()).decode("ascii"), "report": report}
            except Exception as exc:
                telemetry_report = telemetry.stop()
                failure_root = (
                    STATE_ROOT / "failures" / release_fingerprint /
                    str(envelope.get("request_id", "unknown"))
                )
                failure_root.mkdir(parents=True, exist_ok=True)
                failure_report = {
                    "schema": FAILURE_SCHEMA,
                    "request_id": envelope.get("request_id"),
                    "attempt": attempt_number,
                    "request_schema": request_schema,
                    "runtime_release": release,
                    "runtime": runtime,
                    "gpu": facts,
                    "gpu_telemetry": telemetry_report,
                    "phase_durations": _phase_durations(marks),
                    "timing": {
                        "observed_cold_start_upper_bound_seconds": (
                            round(cold_start_seconds, 3) if cold_start_seconds is not None else None
                        ),
                        "worker_execution_seconds": round(time.monotonic() - started, 3),
                    },
                    "error_type": type(exc).__name__,
                    "error": "worker execution failed; inspect error_type and phase_durations",
                }
                (failure_root / f"attempt-{attempt_number}.json").write_text(
                    json.dumps(failure_report, sort_keys=True), encoding="utf-8"
                )
                state_volume.commit()
                raise
            finally:
                telemetry.stop()
                _stop(process)
                if work is not None:
                    shutil.rmtree(work, ignore_errors=True)

    @app.cls(
        image=image, gpu=list(GPU_PLACEMENT), timeout=MAX_EXECUTION_SECONDS_PER_ATTEMPT,
        volumes={"/models": model_volume, "/state": state_volume},
        max_containers=1, min_containers=0,
    )
    class Ref2VAProductionWorker(_WorkerImplementation):
        @modal.method()
        def run(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
            return self._run_impl(
                envelope,
                max_attempts=MAX_ATTEMPTS,
                execution_limit=MAX_EXECUTION_SECONDS_PER_ATTEMPT,
                reserved_max_usd=MAX_COST_USD_PER_ATTEMPT,
            )

else:
    app = None
