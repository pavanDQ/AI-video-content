# AI Medical Video POC — Angular 16 + Node 18

Generates downloadable medical explainer videos with an **AI script**, **AI voice**,
an **animated AI avatar with lip sync**, and **animated medical visuals**, then routes
every video through **clinical review** before doctors can stream or download it.

## Flow

1. **Studio**: enter a topic (plus optional source content), pick a visual style,
   voice, avatar, lip sync, subtitles and resolution.
2. **AI script**: the server writes a storyboard (narration, visual type and
   visual data per scene). It uses Claude when `ANTHROPIC_API_KEY` is set and falls
   back to an offline rule-based planner otherwise.
3. **AI voice**: each scene's narration is synthesised on the server (ElevenLabs, or
   the offline macOS neural voices). The server returns the audio together with a
   **viseme timeline** and a **word timeline**.
4. **Lip sync**: the avatar's mouth is driven by the viseme timeline, blended with
   the decoded audio's loudness envelope, so mouth shapes match the actual sounds.
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

## Engines

| Capability   | With key                                  | Without key                     |
|--------------|-------------------------------------------|---------------------------------|
| Script       | Claude (`ANTHROPIC_API_KEY`)              | Offline planner                 |
| Voice        | ElevenLabs (`ELEVENLABS_API_KEY`), character-accurate timing | macOS `say` neural voices (server must run on macOS) |

Check which engines are live: `GET /api/studio/capabilities`.

## POC limitations

- The avatar and medical illustrations are procedurally drawn on canvas. For
  photoreal presenters, swap `AvatarRendererService` for a provider such as
  HeyGen, D-ID or Synthesia; the storyboard, voice and review pipeline stay as is.
- Output is WebM (VP9 + Opus). If MP4 is required for distribution, transcode on
  the server with FFmpeg after approval.
- Recording runs in real time in the browser, so a 60-second video takes about 60
  seconds to produce. Keep the tab open until it finishes.
- Offline-planner scripts are generic. Every clinical statement must be checked by
  the reviewer before approval.
