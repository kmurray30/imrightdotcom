# Crappy: AI video → sprite sheets

Crappy is the poop-snake mascot behind the public `/crappy` demo page (click
anywhere and he uncurls, slithers over, curls back up). This folder is the
offline pipeline that turns fal.ai video clips into the sprite sheets the
page plays. Nothing here runs on the server; the client only reads
`client/public/crappy/manifest.json` and the PNG sheets next to it.

## The idea

- Two **hub poses** are generated once: `hubs/snake.green.png` (stretched out,
  facing right) and `hubs/curled.green.png` (the soft-serve pile). Every clip
  is generated with a hub pinned as its **first and last frame**, so clips
  chain in any order without pops and loops are seamless:

  | clip      | first  | last   | loop |
  |-----------|--------|--------|------|
  | `uncurl`  | curled | snake  | no   |
  | `slither` | snake  | snake  | yes  |
  | `curl`    | snake  | curled | no   |

  Rest = the static curled hub.
- Clips are **~1 s (24 frames @ 24 fps)**. Kling's shortest clip is 5 s, so
  the action is prompted in slow motion and the ~120 generated frames are
  trimmed to the moving part and resampled down to 24.
- Everything is shot on flat green, chroma-keyed, **re-anchored** so the
  character stays in place (the removed travel is kept in the manifest as a
  trajectory), scaled to one common size, and packed into a 6-column grid.

## Commands

```
npm run crappy -- placeholder                 # procedural stand-in sheets (no network, no key)
npm run crappy -- synthetic --out /tmp/syn    # fake green-screen takes → full extract path (needs ffmpeg)

npm run crappy -- schema [--model <key>]      # print a fal endpoint's input fields (log only)
npm run crappy -- hub snake --n 4 --yes       # snake-pose candidates → hubs/candidates/snake-<n>.png
npm run crappy -- hub snake --ref assets/bunky.png --n 4 --yes
                                              # same, but styled after an existing character image
                                              # (nano-banana/edit + prompts/hub-snake-ref.txt)
npm run crappy -- hub pick snake 2            # promote one to hubs/snake.green.png
npm run crappy -- hub curled --n 2 --yes      # curled candidates, edited from the chosen snake
npm run crappy -- hub pick curled 1
npm run crappy -- clips --yes                 # 3 takes × 3 clips on Kling 2.5 Turbo Pro (≈ $3.15)
npm run crappy -- clips --clip slither --takes 1 --yes
npm run crappy -- extract                     # newest take per clip → client/public/crappy
npm run crappy -- extract --take slither=<takeId>
npm run crappy -- all --yes                   # the whole thing with one candidate each
```

Useful flags: `--dry-run` (print request bodies, no calls), `--safe-words`
(drop the explicit poop reference if a filter objects), `--model <key>` (see
`lib/models.js`; unverified adapters need `--allow-unverified` after you
confirmed their field names with `schema`), `--frame 384x384 --frames 24
--fps 24 --columns 6 --format png|webp --no-palette --blend --erode 1
--key-floor 15 --cfg 0.5 --out <dir>`.

Spending is gated: anything that calls fal refuses without `--yes` (or
`CRAPPY_YES=1`) and prints the estimate first.

## Prerequisites for the paid steps

- `FAL_KEY` in the environment (or `env.local` at the repo root, read by
  `imright/load-env.js`).
- Outbound access to `queue.fal.run`, `fal.run`, `fal.media`, `v3.fal.media`
  (and `fal.ai` for the optional schema check).
- `ffmpeg` + `ffprobe` on PATH for `extract` / `synthetic`.

## What `extract` does, per clip

1. `ffprobe` + `ffmpeg` decode the take to PNG frames (`takes/<id>/frames/`).
2. Key colour = median of the four corner patches of frame 0 (never assume
   `#00FF00`); fails loudly if it isn't green.
3. Chroma key in YCbCr: alpha is a linear ramp of the pixel's chroma distance
   from the key, capped at the "neutral colour" distance so white eyes and
   highlights stay opaque; soft edges are un-mixed and green spill clamped.
4. Motion energy on 96-px thumbnails → the longest contiguous moving run is
   kept (static holds trimmed) → resampled to 24 evenly spaced frames.
5. Per-frame alpha bounding boxes give an anchor (bottom-centre); the smoothed
   anchor path is the **trajectory**, and frames are re-cropped around it.
6. Frames 0 and 23 are replaced by the keyed hub images themselves; a
   head/tail match score says how close the model actually landed.
7. One global scale (snake pose ≈ 45% of the frame height, shrunk if anything
   would overflow) applies to the hubs and every clip.
8. Palette PNG sheets + `manifest.json`; `takes/<id>/debug/contact.png` and
   `energy.json` are written for eyeballing.

## Files

```
cli.js            subcommands above
lib/config.js     sizes, clip table, paths
lib/chroma.js     keying maths (pure)         lib/frames.js   bbox / energy / trim / resample (pure)
lib/align.js      scale + anchor placement    lib/pack.js     grid sheet
lib/manifest.js   schema + validation         lib/placeholder.js  procedural stand-in character
lib/fal-client.js queue REST client           lib/models.js   endpoint adapters
lib/prompts.js    prompt loading              prompts/*.txt   the prompts
lib/ffmpeg.js     decode wrappers             lib/extract.js  orchestration
lib/synthetic.js  fake takes for testing
hubs/             committed hub poses (green)  takes/         gitignored mp4s + frames
__tests__/        node --test (npm run test:unit)
```

The client side lives in `client/src/pages/CrappyPage.jsx`,
`client/src/components/crappy/crappyEngine.js` (state machine + canvas) and
`loadSprites.js` (manifest + image decoding).
