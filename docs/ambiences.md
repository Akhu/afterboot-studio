# Local ambiences with Stable Audio 3

Afterboot 0.11 adds an **Ambiences** workspace alongside the ACE-Step composer.

- **Musical pads** uses Stable Audio 3 `small-music` for ambient music and drones.
- **Sound textures** uses `small-sfx` for sound effects and continuous soundscapes.
- Both modes accept a prompt, a duration of 5–120 seconds and a seed. No BPM or ACE-Step planning parameters are sent to these models.
- Output is WAV. Tracks share the library, favorites, downloads, metadata and settings reuse with music tracks. Settings reuse opens the appropriate workspace.

## Setup on macOS

Double-click `Installer les ambiances.command`, or run this from the Afterboot directory:

```sh
npm run setup:ambiences
```

The installer uses uv and Python 3.12, in an isolated `.stable-audio/.venv` environment. If uv is missing, its official installer is downloaded into `.stable-audio`, without changing the shell profile. The Stable Audio source is pinned to commit `790793b89ddceea612be9ce42ff6830d18f6fa57`. No Gradio server is needed.

The model repositories require Hugging Face access. Open each model card and accept its conditions with your own account:

- [Small-Music](https://huggingface.co/stabilityai/stable-audio-3-small-music)
- [Small-SFX](https://huggingface.co/stabilityai/stable-audio-3-small-sfx)

Then authenticate in the terminal when needed:

```sh
.stable-audio/.venv/bin/hf auth login
```

Enter the token only in that terminal. Afterboot does not request or store it in the browser or its library. Python uses the Hugging Face client's normal local credential storage. Consult the model cards for their license terms.

Start Afterboot normally and open **Ambiances**. The installation check confirms that the Python runtime is present, not that model access has been granted or weights have been downloaded. Weights and text conditioning dependencies download on the first take, then use the normal Hugging Face cache. This requires internet access and enough disk space during setup and first use; generation uses the local machine rather than a paid audio API.

## Memory and configuration

The default device is CPU for compatibility with Apple Silicon. Each take starts an isolated Python process, loads one Small model, writes the audio and exits to release model memory. Switching modes loads the corresponding model on the next take. There is no persistent second model server.

Afterboot refuses overlapping music and ambience jobs. This does not unload models in an independently running ACE-Step server. On a 16 GB Mac, stop other AI model servers if memory is tight. Start with a 5–10 second take; runtime depends on the machine. The native PyTorch path used here does not claim the latency of upstream's separate optimized CoreML runtime.

Optional environment variables, set before launching the studio:

| Variable | Default | Purpose |
| --- | --- | --- |
| `STABLE_AUDIO_PYTHON` | `.stable-audio/.venv/bin/python` under Afterboot | Use a different Python environment with the pinned Stable Audio API installed |
| `STABLE_AUDIO_DEVICE` | `cpu` | `cpu`, `mps` or `cuda`; alternative devices require compatible hardware and libraries |

## Separate hiss and endings

Noise controls are independent from the prompt and have their own saved draft, separate from the ACE-Step composer. Choose white, pink, brown or dark noise, and set the generator gain from −60 to −12 dB. Dark noise is filtered brown noise between 20 and 180 Hz.

FFmpeg adds the noise after generation to a separate WAV copy. The original model audio remains available. The noise slider controls only added noise; it cannot remove hiss the model generated as part of its own output. An optional final fade includes both the generated audio and added noise. Seamless looping is not guaranteed. Noise and fades require FFmpeg; without it, clean generation remains available.

The first version creates individual takes, not long ambience sessions. Existing long ACE-Step sessions retain their own workflow.

## Failures and recovery

Generation continues if the browser closes, as long as the Afterboot Node server remains running. Closing the server also stops its Python workers. On restart, incomplete Python jobs are marked interrupted and must be explicitly relaunched using their saved settings. Afterboot never silently resubmits them. A worker exceeding 30 minutes is stopped.

If generation succeeded but FFmpeg processing failed, the archived original is retained. Checking the track status retries processing without downloading weights or generating a new take. An access error explains how to accept the model conditions and authenticate; prompts and settings remain available for reuse.

## Implementation and validation

`ambience-engine.mjs` launches `scripts/stable_audio_worker.py` using a private JSON-lines protocol, without a shell. The worker uses upstream `StableAudioModel.from_pretrained` and `generate`, fixes generation to eight steps and one sample, passes the requested seed, and writes a stereo PCM WAV before the existing Afterboot processing pipeline runs. Stable Audio's own output is clamped to the PCM range without applying a separate peak normalization.

Tests cover validation, model selection, missing runtime, resource exclusion, saved errors, restart recovery, post-processing retries and shared library persistence. HTTP integration tests use a simulated model with real FFmpeg processing; they do not demonstrate model audio quality. A real generation additionally requires access to the gated weights.

References: [upstream code and hardware notes](https://github.com/Stability-AI/stable-audio-3), [official prompting guide](https://stability.ai/guides/stable-audio-3-prompt-guide).
