# AI Medical Video POC — Angular 16 + Node 18

Generates downloadable medical explainer videos with an **AI script**, **AI voice**,
an **animated AI avatar with lip sync**, and **animated medical visuals**, then routes
every video through **clinical review** before doctors can stream or download it.

## Flow

1. **Studio**: enter a topic (plus optional source content), pick a visual style,
   voice, avatar, lip sync, subtitles and resolution. Source content can be plain
   text or pasted article HTML (even JSON-escaped): the server strips tags and
   entities so only prose is narrated, moves a trailing "Reference" section into the
   reviewer notes, and shows each `<img>` as an **image scene** next to the text it
   sat beside. Images load through `GET /api/studio/image?url=…`, a same-origin
   proxy (public http(s) raster images only), because a cross-origin image would
   taint the canvas and stop it from being recorded.
2. **AI script**: the server writes a storyboard (narration, visual type and
   visual data per scene). It uses Claude when `ANTHROPIC_API_KEY` is set and falls
   back to an offline rule-based planner otherwise.
3. **AI voice**: each scene's narration is synthesised on the server (ElevenLabs, or
   an offline neural voice: macOS `say` on a Mac, Piper on Linux). The server returns
   the audio together with a **viseme timeline** and a **word timeline**.
4. **Lip sync**: the avatar's mouth is driven by the viseme timeline, blended with
   the decoded audio's loudness envelope, so mouth shapes match the actual sounds.
   The default presenter is a **3D avatar** (three.js, `src/assets/avatars/presenter.glb`,
   CC0 — see the `LICENSE.md` beside it): the timeline drives its Oculus viseme blend
   shapes, and blinks, gaze and head motion are computed from the frame time so a
   re-render is identical. The four drawn presenters remain selectable and are the
   automatic fallback when WebGL or the model is unavailable.
5. **Render and record**: the canvas renders the avatar and the scene animations
   (whiteboard, step diagram, comparison, disease progression, animated anatomy:
   heart, lungs, brain, kidney, liver, stomach, vessels, cells). The narration is
   routed through Web Audio into the same `MediaStream` as the canvas, so the
   downloaded WebM contains **both video and voice**. Timing is driven by the
   AudioContext clock, so picture and voice stay in sync.
6. **Review**: *Submit for review* stores the video in the review queue. A reviewer
   can preview it, edit scene narration, and approve, request changes, or reject.
7. **Doctor library**: only approved videos are listed and servable; doctors can
   stream or download them. Unapproved media returns 403.

## Run

```bash
npm install
npm run server:install
cp server/.env.example server/.env   # optional: add API keys
npm run dev                          # API on :3000, Angular on :4200
```

Open `http://localhost:4200`.

> `npm start` only starts Angular. If the dev server logs
> `ECONNREFUSED` for `/api/...`, the API on :3000 is not running: use
> `npm run dev`, or run `npm run server` in a second terminal.

### Offline voice on Linux (Piper)

Without an ElevenLabs key, a Linux server uses [Piper](https://github.com/rhasspy/piper),
a free offline neural voice. Its binary and voice models live in `server/vendor/piper/`,
which is git-ignored, so each machine downloads them once (~125 MB):

```bash
mkdir -p server/vendor/piper/voices && cd server/vendor/piper
curl -sSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar xz
cd voices
BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US
for v in lessac ryan; do
  curl -sSLO $BASE/$v/medium/en_US-$v-medium.onnx
  curl -sSLO $BASE/$v/medium/en_US-$v-medium.onnx.json
done
```

Restart the server afterwards. "AI Female Voice" maps to `en_US-lessac-medium` and
"AI Male Voice" to `en_US-ryan-medium`. Change them with `PIPER_VOICE_FEMALE`,
`PIPER_VOICE_MALE` and `PIPER_LENGTH_SCALE` (speed; higher is slower) in `server/.env`.

## Engines

| Capability   | With key                                  | Without key                     |
|--------------|-------------------------------------------|---------------------------------|
| Script       | Claude (`ANTHROPIC_API_KEY`)              | Offline planner                 |
| Voice        | ElevenLabs (`ELEVENLABS_API_KEY`), character-accurate timing | macOS `say` neural voices (server on macOS), or Piper (server on Linux, see above) |

With `TTS_ENGINE=auto` the server tries ElevenLabs, then macOS, then Piper. The
offline engines return no timestamps, so the server derives them from the audio
(`server/src/services/tts/align.js`): it finds the silences in the rendered WAV, pins
each sentence and comma pause in the text to the silence it produced, and spreads
sounds only within the stretches of actual speech. Timing error stays within a
clause (typically under 100 ms) instead of accumulating across a scene.

Check which engines are live: `GET /api/studio/capabilities`.

## POC limitations

- The 3D presenter is a stock CC0 MakeHuman model (recoloured scrub top, iris
  colour corrected at load). A custom presenter needs a GLB with Oculus viseme and
  ARKit blend shapes and a Mixamo-style rig; set it as a preset's `model`. For
  photoreal video presenters, a provider such as HeyGen, D-ID or Synthesia can
  replace `AvatarRendererService`; the storyboard, voice and review pipeline stay as is.
- The medical illustrations are procedurally drawn on canvas.
- Output is WebM (VP9 + Opus). If MP4 is required for distribution, transcode on
  the server with FFmpeg after approval.
- Recording runs in real time in the browser, so a 60-second video takes about 60
  seconds to produce. Keep the tab open until it finishes.
- Offline-planner scripts are generic. Every clinical statement must be checked by
  the reviewer before approval.
