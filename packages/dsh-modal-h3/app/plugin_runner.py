#!/usr/bin/env python3
"""One-shot bridge between the DSH plugin's host half and the deployed Modal App.

Every subcommand is a separate process invocation, spawned by `src/runner.js`
inside the pinned `pixi exec` environment. The split exists because the Modal
client must not run inside the harness process: `modal` is a heavy dependency
with its own event loop and its own token discovery, and a long-lived harness
process would keep one authenticated gRPC channel per account alive forever.

Credentials arrive ONLY as `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the child
environment, injected per call from the `MODAL_H3_ACCOUNTS` credential. Nothing
is written to `~/.modal.toml`, so no account's token ever touches disk.

Subcommands (all print one JSON object on stdout):

    preflight --spec <job.json>          local-only admission; no network, no writes
    probe                                is the App deployed for this account?
    sync                                 ensure volumes + deploy + bootstrap + probe
    submit --task-dir <dir>              spawn one generation, record its call id
    poll   --task-dir <dir>              one non-blocking status check
    wait   --task-dir <dir> --timeout N  block until final or the deadline
    cancel --task-dir <dir>              cancel the recorded call
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Sequence

APP_FILE = Path(__file__).resolve().with_name("modal_h3_app.py")

from modal_h3_contract import (  # noqa: E402  (path setup is the script's own dir)
    APP_NAME,
    HEIGHT,
    MODEL_VOLUME_NAME,
    PRODUCTION_WORKER_NAME,
    STATE_VOLUME_NAME,
    WIDTH,
    H3ContractError,
    build_request,
    cpu_preflight,
    resolve_tool,
    runtime_release,
    transport_references,
    validate_result_envelope,
)

REQUEST_FILE = "request.json"
CALL_FILE = "call.json"
OUTPUT_FILE = "output.mp4"
REPORT_FILE = "report.json"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = result.add_subparsers(dest="command", required=True)
    preflight = sub.add_parser("preflight")
    preflight.add_argument("--spec", type=Path, required=True)
    sub.add_parser("probe")
    sub.add_parser("sync")
    for name in ("submit", "poll", "cancel"):
        item = sub.add_parser(name)
        item.add_argument("--task-dir", type=Path, required=True)
    wait = sub.add_parser("wait")
    wait.add_argument("--task-dir", type=Path, required=True)
    wait.add_argument("--timeout", type=float, default=1800.0)
    return result


def _references(spec: dict[str, Any]) -> dict[str, list[Path]]:
    raw = spec.get("references")
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise H3ContractError("job spec references must be an object")
    return {
        kind: [Path(value) for value in raw.get(kind, [])]
        for kind in ("images", "videos", "audios")
    }


def _request_from_spec(spec: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, list[Path]]]:
    prompt = spec.get("prompt")
    if not isinstance(prompt, str):
        raise H3ContractError("job spec prompt must be text")
    duration = spec.get("duration_seconds", 4.0)
    paths = _references(spec)
    request = build_request(
        prompt,
        duration_seconds=duration,
        reference_images=paths["images"],
        reference_videos=paths["videos"],
        reference_audios=paths["audios"],
    )
    return request, cpu_preflight(request), paths


def preflight(spec_path: Path) -> dict[str, Any]:
    """Local admission only: no credential use, no mkdir, no Modal import."""
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if not isinstance(spec, dict):
        raise H3ContractError("job spec must be an object")
    request, preflight_result, _ = _request_from_spec(spec)
    return {
        "status": "admitted",
        "app": APP_NAME,
        "request": request,
        "preflight": preflight_result,
    }


def _modal():
    import modal

    return modal


def probe() -> dict[str, Any]:
    modal = _modal()
    try:
        modal.Function.from_name(APP_NAME, "bootstrap").hydrate()
        modal.Cls.from_name(APP_NAME, PRODUCTION_WORKER_NAME).hydrate()
    except modal.exception.NotFoundError as exc:
        return {"status": "not-deployed", "app": APP_NAME, "message": str(exc)[:500]}
    except modal.exception.AuthError as exc:
        return {"status": "auth-failed", "app": APP_NAME, "message": str(exc)[:500]}
    return {"status": "deployed", "app": APP_NAME, "worker": PRODUCTION_WORKER_NAME}


def sync() -> dict[str, Any]:
    """Create the volumes, deploy this App, verify the model manifest, then probe.

    Every step is idempotent: a rolling deploy replaces the same App, and
    `bootstrap` skips any artifact whose size and sha256 already match, so a
    retry after a partial failure costs only the re-verification.
    """
    modal = _modal()
    for name in (MODEL_VOLUME_NAME, STATE_VOLUME_NAME):
        modal.Volume.from_name(name, create_if_missing=True).hydrate()
    completed = subprocess.run(
        [sys.executable, "-m", "modal", "deploy", "--strategy", "rolling", str(APP_FILE)],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(APP_FILE.parent),
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip().splitlines()[-6:]
        raise H3ContractError("modal deploy failed: " + " | ".join(detail))
    receipt = modal.Function.from_name(APP_NAME, "bootstrap").remote()
    if not isinstance(receipt, dict):
        raise H3ContractError("Modal bootstrap returned an invalid receipt")
    state = probe()
    if state["status"] != "deployed":
        raise H3ContractError(f"the deployed App is not reachable after sync: {state['status']}")
    return {
        "status": "synced",
        "app": APP_NAME,
        "runtime_release_fingerprint": runtime_release()["fingerprint"],
        "verified_artifacts": len(receipt.get("verified", [])),
    }


def submit(task_dir: Path) -> dict[str, Any]:
    spec = json.loads((task_dir / "job.json").read_text(encoding="utf-8"))
    request, preflight_result, paths = _request_from_spec(spec)
    references = transport_references(
        request,
        images=paths["images"],
        videos=paths["videos"],
        audios=paths["audios"],
    )
    envelope = {
        "request": request,
        "request_id": preflight_result["request_id"],
        "runtime_release_fingerprint": preflight_result["runtime_release"]["fingerprint"],
        "references": references,
        "client_submitted_unix_seconds": time.time(),
    }
    # Written before the spawn so a crash between the two still leaves the
    # canonical request on disk for validation of whatever the worker returns.
    (task_dir / REQUEST_FILE).write_text(
        json.dumps({"request": request, "preflight": preflight_result}, separators=(",", ":")),
        encoding="utf-8",
    )
    modal = _modal()
    worker = modal.Cls.from_name(APP_NAME, PRODUCTION_WORKER_NAME)()
    call = worker.run.spawn(envelope)
    (task_dir / CALL_FILE).write_text(
        json.dumps({"function_call_id": call.object_id}, separators=(",", ":")),
        encoding="utf-8",
    )
    return {
        "status": "submitted",
        "function_call_id": call.object_id,
        "request_id": preflight_result["request_id"],
        "runtime_release_fingerprint": preflight_result["runtime_release"]["fingerprint"],
        "reference_counts": {
            kind: len(paths[kind]) for kind in ("images", "videos", "audios")
        },
        "duration_seconds": request["duration_seconds"],
        "output_frames": request["output_frames"],
    }


def _postprocess(source: Path, output: Path, *, generation_frames: int, output_frames: int, duration_seconds: float) -> None:
    command = [
        resolve_tool("ffmpeg"), "-y", "-v", "error", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0",
        "-vf", f"fps=24,scale={WIDTH}:{HEIGHT}:flags=lanczos", "-frames:v", str(output_frames),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-af", f"apad=pad_dur={duration_seconds},atrim=0:{duration_seconds}",
        "-c:a", "aac", "-ac", "2", "-ar", "48000",
        "-movflags", "+faststart", str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise H3ContractError(
            f"{generation_frames}-to-{output_frames} frame postprocess failed: {result.stderr.strip()[:500]}"
        )


def _ffprobe(path: Path, *, output_frames: int, duration_seconds: float) -> dict[str, Any]:
    result = subprocess.run(
        [resolve_tool("ffprobe"), "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise H3ContractError(f"ffprobe failed for delivered MP4: {result.stderr.strip()[:500]}")
    payload = json.loads(result.stdout)
    video = next((stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in payload.get("streams", []) if stream.get("codec_type") == "audio"), None)
    if not video or not audio:
        raise H3ContractError("delivered MP4 must contain video and native audio")
    frame_count = int(video.get("nb_read_frames") or video.get("nb_frames") or 0)
    duration = float(payload.get("format", {}).get("duration") or 0)
    if video.get("codec_name") != "h264" or (video.get("width"), video.get("height")) != (WIDTH, HEIGHT):
        raise H3ContractError(f"delivered video must be H.264 at {WIDTH}x{HEIGHT}")
    if (
        video.get("avg_frame_rate") != "24/1"
        or frame_count != output_frames
        or not duration_seconds - 0.01 <= duration <= duration_seconds + 0.02
    ):
        raise H3ContractError(
            f"delivered video must be exactly {output_frames} frames at 24fps/{duration_seconds:g} seconds"
        )
    if int(audio.get("channels") or 0) != 2:
        raise H3ContractError("delivered native audio must be stereo")
    return {
        "video_codec": video.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "frame_count": frame_count,
        "avg_frame_rate": video.get("avg_frame_rate"),
        "duration_seconds": round(duration, 6),
        "audio_channels": int(audio.get("channels") or 0),
        "bytes": path.stat().st_size,
    }


def _finish(task_dir: Path, result: Any) -> dict[str, Any]:
    """Validate the worker's envelope, then write the postprocessed MP4 and report."""
    record = json.loads((task_dir / REQUEST_FILE).read_text(encoding="utf-8"))
    request, preflight_result = record["request"], record["preflight"]
    payload, report = validate_result_envelope(result, request=request, preflight=preflight_result)
    generated = task_dir / "generated.mp4"
    generated.write_bytes(payload)
    output = task_dir / OUTPUT_FILE
    try:
        _postprocess(
            generated,
            output,
            generation_frames=int(request["generation_frames"]),
            output_frames=int(request["output_frames"]),
            duration_seconds=float(request["duration_seconds"]),
        )
        evidence = _ffprobe(
            output,
            output_frames=int(request["output_frames"]),
            duration_seconds=float(request["duration_seconds"]),
        )
    except H3ContractError as exc:
        # The GPU run succeeded; only the local delivery step failed. The raw
        # worker output is kept, because deleting it would throw away the one
        # artifact that a paid generation produced.
        raise H3ContractError(f"{exc} (the worker's raw output is kept at {generated})") from exc
    generated.unlink(missing_ok=True)
    (task_dir / REPORT_FILE).write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    return {
        "status": "completed",
        "output_path": str(output),
        "report_path": str(task_dir / REPORT_FILE),
        "ffprobe": evidence,
        "elapsed_seconds": report.get("elapsed_seconds"),
        "estimated_gpu_cost_usd": report.get("estimated_gpu_cost_usd"),
    }


def _call_state(task_dir: Path, *, timeout: float) -> dict[str, Any]:
    """One poll of the recorded function call.

    The exception order is load-bearing. Modal's own `TimeoutError` means "no
    output yet", and two of its subclasses mean something else entirely:
    `OutputExpiredError` is a final state (the call outlived the output
    retention window), and `FunctionTimeoutError` is a failure. Both must be
    caught before the base class, or a finished failure reads as "still
    running" forever. The builtin `TimeoutError` is deliberately NOT caught —
    Modal's hierarchy does not inherit from it, so catching it would silently
    turn every poll into a busy loop.
    """
    call_record = task_dir / CALL_FILE
    if not call_record.is_file():
        return {"status": "unsubmitted"}
    function_call_id = json.loads(call_record.read_text(encoding="utf-8"))["function_call_id"]
    modal = _modal()
    call = modal.FunctionCall.from_id(function_call_id)
    try:
        result = call.get(timeout=timeout)
    except modal.exception.OutputExpiredError:
        return {"status": "expired", "function_call_id": function_call_id}
    except modal.exception.FunctionTimeoutError as exc:
        return {"status": "failed", "function_call_id": function_call_id, "message": str(exc)[-1000:]}
    except modal.exception.TimeoutError:
        return {"status": "running", "function_call_id": function_call_id}
    except modal.exception.NotFoundError as exc:
        return {"status": "unknown", "function_call_id": function_call_id, "message": str(exc)[:500]}
    except (modal.exception.ExecutionError, modal.exception.InternalFailure) as exc:
        return {"status": "failed", "function_call_id": function_call_id, "message": str(exc)[-1000:]}
    try:
        outcome = _finish(task_dir, result)
    except (H3ContractError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        # The call finished but its delivery failed validation or postprocessing.
        # That is a FINAL failure of this task, not a broken runner: reporting it
        # as a task status is what lets the model stop polling and act, instead of
        # seeing an opaque exit code and retrying a generation that already ran.
        return {"status": "failed", "function_call_id": function_call_id, "message": str(exc)[:1000]}
    outcome["function_call_id"] = function_call_id
    return outcome


def poll(task_dir: Path) -> dict[str, Any]:
    return _call_state(task_dir, timeout=0)


def wait(task_dir: Path, timeout: float) -> dict[str, Any]:
    """Long-poll in slices so a single process spans the whole generation."""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"status": "running", "deadline_exceeded": True}
        state = _call_state(task_dir, timeout=min(20.0, remaining))
        if state["status"] != "running":
            return state


def cancel(task_dir: Path) -> dict[str, Any]:
    call_record = task_dir / CALL_FILE
    if not call_record.is_file():
        return {"status": "unsubmitted"}
    function_call_id = json.loads(call_record.read_text(encoding="utf-8"))["function_call_id"]
    modal = _modal()
    try:
        modal.FunctionCall.from_id(function_call_id).cancel()
    except modal.exception.NotFoundError as exc:
        return {"status": "unknown", "function_call_id": function_call_id, "message": str(exc)[:500]}
    except modal.exception.OutputExpiredError:
        return {"status": "expired", "function_call_id": function_call_id}
    return {"status": "cancelled", "function_call_id": function_call_id}


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "preflight":
            result = preflight(args.spec)
        elif args.command == "probe":
            result = probe()
        elif args.command == "sync":
            result = sync()
        elif args.command == "submit":
            result = submit(args.task_dir)
        elif args.command == "poll":
            result = poll(args.task_dir)
        elif args.command == "wait":
            result = wait(args.task_dir, args.timeout)
        else:
            result = cancel(args.task_dir)
    except (H3ContractError, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        print(f"modal-h3-runner: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - see below
        # Modal's own failures (ResourceExhaustedError, AuthError, NotFoundError,
        # ConflictError) arrive here. They are reported as ONE line, because this
        # message becomes task state that the model reads and that
        # `accounts_status` shows: a Python traceback would bury the sentence that
        # says what to do ("workspace billing cycle spend limit reached") under
        # forty lines of `await` frames. `MODAL_H3_RUNNER_TRACEBACK=1` restores the
        # traceback for debugging, where it is the thing you actually want.
        if os.environ.get("MODAL_H3_RUNNER_TRACEBACK") == "1":
            traceback.print_exc()
        print(f"modal-h3-runner: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
