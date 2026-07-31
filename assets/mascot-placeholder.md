# Mascot art brief

No image exists yet. This file is the brief to hand to an artist or an image model.
When art lands, drop it in this folder and replace the `<!-- MASCOT_HERO_IMAGE -->`
comment in the README.

## Subject

A small, round, fuzzy panda cub. Sitting. Hugging a single bamboo shoot against
its chest with both arms. Eyes closed. Smiling warmly.

## Form

- Soft, rounded shapes throughout. No sharp edges or angular geometry.
- Chibi proportions — oversized head, small body, stubby limbs.
- Fur reads as soft and slightly fuzzy at the silhouette edge, not slick or vector-flat.

## Palette

- Classic panda black-and-white for the cub.
- Soft greens for the bamboo shoot — fresh and light, not deep forest green.
- Overall warm and approachable. Cream or very light neutral background.

## Style reference

Pixar / Studio Ghibli chibi character warmth. Explicitly **not** photorealistic,
and **not** edgy, corporate, or aggressive.

## Tone guardrail

Shoot is a cheerleader that insists on honesty, not a cop. The mascot must never
look stern, scolding, or disapproving — no crossed arms, no wagging finger, no
frown, no police or referee motifs. The character is happy to be holding the
shoot; the strictness lives in the tool's behavior, never in the mascot's face.

## What already ships (match this)

The terminal output is already live and the art must stay consistent with it.

- **Emoji:** 🐼 `U+1F43C` (PANDA FACE). Every user-facing line is prefixed
  `🐼 Shoot: ...`. Defined once as `PANDA` in
  [`src/mascot/messages.ts`](../src/mascot/messages.ts) — if the mascot ever changes
  species, that constant and this brief change together.
- **ASCII art** shown after `shoot init`, with the tagline *"verify before you grow"*:

```
      .--.   .--.
     ( 🐼 )_( 🐼 )      shoot
      '--'   '--'
       \  |ǂ|  /
          |ǂ|            verify before you grow
```

  The `|ǂ|` is the bamboo shoot. Any illustrated version should keep the same
  reading: panda(s) plus one bamboo shoot, warm rather than stern.

- **Voice reference**, for tone matching:
  - Pass: `🐼 Shoot: Nice work — test passed. Cleared to grow.`
  - Block: `🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:`
  - Stand-down: `🐼 Shoot: I've paused this 3 times now ... a human should look at it.`

  Encouraging and direct. Never scolding, never cute to the point of irritating.

## Deliverables (eventual)

- Hero image for the README, transparent background, ~1200px wide. Replaces the
  `<!-- MASCOT_HERO_IMAGE -->` comment near the top of [README.md](../README.md).
- Square avatar crop for npm / GitHub org, 512x512.
