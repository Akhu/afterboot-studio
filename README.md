# Afterboot Studio

[English](README.md) · [Français](README.fr.md)

A retro music workstation for the [official ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) API. Create instrumentals, keep your seeds in view, and collect your tracks in a local library.

Independent community UI. ACE-Step runs separately and provides all music generation. No model weights are bundled.

![Afterboot Studio in English](docs/screenshots/en.jpg)

## Preview status

Version 0.4.0 is an early preview. The UI has been checked in a browser and the API integration has automated tests against a simulated ACE-Step server. End-to-end generation with a real ACE-Step installation still needs validation. Hardware performance depends on the engine and its models.

## What you can do

- Switch between English and French. Your language choice is saved per browser.
- Create instrumentals with a prompt, BPM, duration and a visible seed.
- Start with jungle, liquid DnB and ambient presets.
- Use ACE-Step Turbo with 8 steps, one track at a time, and optional 5Hz LM planning.
- Follow actual job status and resume tracking after reloading the page.
- Listen, search, mark favorites and restore a track's generation settings.
- Download WAV, FLAC or MP3 audio and JSON generation metadata.
- Open the studio from another computer on your private network.

Switching UI languages preserves prompts, titles and settings. Preset prompts stay in English. Raw engine messages retain their original language.

A seed alone does not guarantee identical audio across different model versions, hardware or LM planning runs.

## Requirements

- Node.js 20 or newer.
- An installed and working ACE-Step 1.5 REST API with the Turbo model.
- A modern browser.

This project has no npm dependencies. ACE-Step has its own installation requirements and model downloads. Follow its [installation guide](https://github.com/ace-step/ACE-Step-1.5#readme) first.

## Start locally

Start the API from your ACE-Step installation. On Apple Silicon macOS, the official launcher is:

~~~bash
bash start_api_server_macos.sh
~~~

Wait for the engine to finish loading. The default API address is http://127.0.0.1:8001. Stop your existing Gradio process first if you use the same engine installation and want to avoid loading the models twice.

In a second terminal:

~~~bash
git clone https://github.com/Akhu/afterboot-studio.git
cd afterboot-studio
npm start
~~~

Open [Afterboot Studio](http://127.0.0.1:3210).

On macOS, you can also double-click `Lancer le studio.command`. It starts the UI only. Start ACE-Step separately.

Try 60 seconds at 170 BPM first. The UI supports 10–600 seconds, but your engine and hardware may impose lower limits.

## Use another computer on your network

If the UI and ACE-Step run on the same machine, leave Python on its default loopback address. Start the UI with:

~~~bash
npm run start:lan
~~~

The terminal prints the network URLs. On another device connected to the same private network, open `http://<studio-machine-ip>:3210`. Use the printed IP address rather than a hostname. Allow Node's incoming connections if your firewall asks.

All connected users share the server's library and can generate music. LAN mode has no login and is intended for a trusted private network. Keep these ports off the public internet. The default `npm start` remains accessible only on the host computer.

### Run ACE-Step on a separate machine

Only in this setup does Python also need a network listener. On the Apple Silicon machine hosting an existing uv-based ACE-Step installation, stop its current server with Ctrl+C, then run this inside the ACE-Step folder:

~~~bash
ACESTEP_LM_BACKEND=mlx uv run acestep-api --host 0.0.0.0 --port 8001
~~~

For the official embedded-Python package, change `HOST="127.0.0.1"` to `HOST="0.0.0.0"` inside `start_api_server_macos.sh`, then relaunch that script. Its HOST setting is internal, so prefixing the script with a HOST environment variable does not override it. See the [official macOS launcher](https://github.com/ace-step/ACE-Step-1.5/blob/main/start_api_server_macos.sh).

On the machine hosting this UI, point it to the engine's IP:

~~~bash
ACESTEP_API_URL=http://<engine-machine-ip>:8001 npm run start:lan
~~~

These environment assignments use macOS/Linux shell syntax. In PowerShell, set `$env:ACESTEP_API_URL = "http://<engine-machine-ip>:8001"` before running npm.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACESTEP_API_URL` | `http://127.0.0.1:8001` | ACE-Step API address |
| `ACESTEP_API_KEY` | Empty | Optional engine key, sent only by the Node server |
| `PORT` | `3210` | Studio port |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` for LAN access, or use `npm run start:lan` |

Environment variables must be set in the launching terminal. The studio does not automatically load .env files. Configure an optional engine API key following the [official authentication documentation](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md#1-authentication).

## Storage and scope

Audio and generation metadata live in `.data/` beside the server. Back up that folder to keep the library. It is excluded from Git along with environment files. Drafts and language preferences live in each browser's local storage.

The studio copies completed audio from ACE-Step into its own library. Existing Gradio outputs are not imported automatically. A paused job tracker does not cancel generation on the engine; use “Check status” to resume it. Pending outputs remain subject to the engine's cache policy until copied.

This preview supports instrumental text-to-music only. Remix, repaint, LoRA training and hour-long mix assembly are outside its current scope. The LM backend is MLX on macOS and PyTorch elsewhere.

## Development

~~~bash
npm test
~~~

Tests cover input validation, submission and polling, audio archiving and range playback, returned seeds, persistence, engine failures, and LAN host/origin checks. They do not download models or generate music.

The app uses HTML, CSS and browser JavaScript with a Node.js server. Requests follow this path:

~~~text
Browser → Afterboot Node server → official ACE-Step REST API
~~~

The server uses `/release_task`, `/query_result`, `/health` and `/v1/audio`.

## Credits and license

Music generation is powered by [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5). Thanks to the ACE-Step authors and contributors for the engine and its [API documentation](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md).

Afterboot Studio is an independent client, maintained separately from ACE-Step, with no official affiliation. This UI is available under the [MIT license](LICENSE). ACE-Step and its models retain their respective licenses; consult the [upstream license](https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE) and model cards before use.
