"""Afterboot's private JSON-lines protocol for the official Stable Audio 3 API."""
import contextlib
import gc
import importlib.util
import json
import os
from pathlib import Path
import sys


def emit(kind, **values):
    print(json.dumps({"type": kind, **values}), flush=True)


def main():
    if "--check" in sys.argv:
        available = all(importlib.util.find_spec(name) is not None for name in ("stable_audio_3", "torch", "soundfile"))
        emit("result", available=available, device=os.environ.get("STABLE_AUDIO_DEVICE", "cpu"))
        return

    request = json.load(sys.stdin)
    if request["model"] not in ("small-music", "small-sfx"):
        raise ValueError("Unsupported model")
    if not 5 <= request["duration"] <= 120:
        raise ValueError("Unsupported duration")
    output = Path(request["output"])
    temporary = output.with_suffix(".tmp.wav")
    emit("progress", phase="loading")
    # Upstream libraries print to stdout. Keep that separate from our protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import soundfile as sf
        from stable_audio_3 import StableAudioModel

        device = os.environ.get("STABLE_AUDIO_DEVICE", "cpu")
        if device not in ("cpu", "mps", "cuda"):
            raise ValueError("STABLE_AUDIO_DEVICE must be cpu, mps or cuda")
        model = StableAudioModel.from_pretrained(request["model"], device=device, model_half=device == "cuda")
    emit("progress", phase="generating")
    with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
        audio = model.generate(
            prompt=request["prompt"], duration=request["duration"], seed=request["seed"],
            steps=8, cfg_scale=1.0, batch_size=1, chunked_decode=True,
        )
        samples = audio[0].detach().to(device="cpu", dtype=torch.float32).clamp(-1, 1).transpose(0, 1).numpy()
        rate = model.model.sample_rate
        if samples.shape[0] == 0 or not bool(torch.isfinite(torch.from_numpy(samples)).all()):
            raise ValueError("Invalid audio output")
        sf.write(temporary, samples, rate, subtype="PCM_24")
        temporary.replace(output)
        del audio, model, samples
        gc.collect()
    emit("result", seed=request["seed"], sampleRate=rate)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        chain = []
        current = error
        while current is not None and len(chain) < 6:
            chain.append(type(current).__name__ + " " + str(current).lower())
            current = current.__cause__ or current.__context__
        detail = " ".join(chain)
        if "gated" in detail or "401" in detail or "403" in detail or "unauthorized" in detail:
            code = "errorAmbienceAccess"
        elif isinstance(error, (ImportError, ModuleNotFoundError)):
            code = "errorAmbienceMissing"
        elif "out of memory" in detail or "cannot allocate memory" in detail:
            code = "errorAmbienceMemory"
        else:
            code = "errorAmbienceGeneration"
        emit("error", code=code)
        sys.exit(1)
