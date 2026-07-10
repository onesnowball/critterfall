#!/usr/bin/env node
// Generate illustrated critter art for every Trait using Google's
// Gemini 2.5 Flash Image model ("nano banana").
//
// Usage:
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs           # all missing
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs t150 t151 # specific ids
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs --force   # regenerate all
//
// Output: client/public/art/<id>.png  (skips ids that already exist unless --force)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CARDS = path.join(ROOT, "server", "cards.json");
const OUT_DIR = path.join(ROOT, "client", "public", "art");
const MANIFEST = path.join(ROOT, "client", "src", "artManifest.json");

function writeManifest() {
  const ids = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".png"))
    .map((f) => f.replace(/\.png$/, ""))
    .sort();
  fs.writeFileSync(MANIFEST, `${JSON.stringify(ids, null, 0)}\n`);
  console.log(`Wrote manifest with ${ids.length} ids -> ${path.relative(ROOT, MANIFEST)}`);
}

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const COLOR_MOOD = {
  Green: "lush mossy greens and warm amber, earthy growth energy",
  Red: "fiery reds and molten orange, aggressive and hot",
  Blue: "cool teals and deep ocean blues, calm and controlling",
  Purple: "rich violets and arcane magenta, mystical and scoring",
  Colorless: "soft neutral bone-white and slate grey, understated"
};

function stylePrompt(card) {
  const mood = COLOR_MOOD[card.color] || COLOR_MOOD.Colorless;
  return [
    `A single adorable original fantasy critter representing "${card.name}".`,
    `Concept flavor: ${card.text || card.name}.`,
    `Style: cute painterly trading-card-game creature illustration, bold clean outlines,`,
    `soft cel shading, expressive, storybook charm, Balatro-meets-Pokemon energy.`,
    `Palette leans into ${mood}.`,
    `The creature is centered, full body, facing the viewer, on a simple softly`,
    `vignetted background that matches the palette. Square composition.`,
    `Absolutely no text, no letters, no numbers, no words, no UI, no border, no frame,`,
    `no watermark. Just the creature and its background.`
  ].join(" ");
}

async function generateOne(card) {
  const body = {
    contents: [{ parts: [{ text: stylePrompt(card) }] }]
  };

  const res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const image = parts.find((p) => p.inlineData?.data);

  if (!image) {
    const textPart = parts.find((p) => p.text)?.text || "no image returned";
    throw new Error(`No image in response: ${textPart.slice(0, 200)}`);
  }

  return Buffer.from(image.inlineData.data, "base64");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!API_KEY) {
    console.error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const data = JSON.parse(fs.readFileSync(CARDS, "utf8"));
  const traits = data.traits || [];

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const idFilter = args.filter((a) => !a.startsWith("--"));

  let targets = traits;
  if (idFilter.length) {
    targets = traits.filter((c) => idFilter.includes(c.id));
  }
  if (!force) {
    targets = targets.filter((c) => !fs.existsSync(path.join(OUT_DIR, `${c.id}.png`)));
  }

  console.log(`Model: ${MODEL}`);
  console.log(`${targets.length} card(s) to generate (of ${traits.length} total).`);

  let done = 0;
  let failed = 0;
  for (const card of targets) {
    const outPath = path.join(OUT_DIR, `${card.id}.png`);
    let attempt = 0;
    // Retry a few times for transient rate limits / hiccups.
    while (attempt < 4) {
      attempt += 1;
      try {
        const buf = await generateOne(card);
        fs.writeFileSync(outPath, buf);
        done += 1;
        console.log(`  ✓ ${card.id}  ${card.name}  (${done}/${targets.length})`);
        break;
      } catch (err) {
        const wait = 1500 * attempt;
        if (attempt >= 4) {
          failed += 1;
          console.error(`  ✗ ${card.id}  ${card.name}  — ${err.message}`);
        } else {
          console.warn(`  … ${card.id} retry ${attempt} after ${wait}ms — ${err.message}`);
          await sleep(wait);
        }
      }
    }
    // Gentle pacing to stay under rate limits.
    await sleep(600);
  }

  writeManifest();
  console.log(`\nDone. ${done} generated, ${failed} failed. Art in ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
