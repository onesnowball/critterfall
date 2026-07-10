#!/usr/bin/env node
// Generate illustrated art for every Trait (cute critters) and Age (era scenes)
// using Google's Gemini 2.5 Flash Image model ("nano banana"), then downscale
// each to a small WebP for a light repo footprint.
//
// Usage:
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs               # all missing (traits + ages)
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs t150 a006     # specific ids
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs --traits      # traits only
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs --ages        # ages only
//   GEMINI_API_KEY=xxx node scripts/generate-art.mjs --force       # regenerate
//
// Output: client/public/art/<id>.webp  (skips ids that already exist unless --force)

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CARDS = path.join(ROOT, "server", "cards.json");
const OUT_DIR = path.join(ROOT, "client", "public", "art");
const MANIFEST = path.join(ROOT, "client", "src", "artManifest.json");
const TOOLS_DIR = path.join(__dirname, ".artgen-tools");

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const WEBP_WIDTH = Number(process.env.ART_WIDTH || 512);
const WEBP_QUALITY = Number(process.env.ART_QUALITY || 80);

// Lazy-load sharp; install it into an isolated folder if the environment
// doesn't already provide it (keeps it out of the pinned root workspace deps).
async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    // fall through to isolated install
  }
  const localEntry = path.join(TOOLS_DIR, "node_modules", "sharp");
  if (!fs.existsSync(localEntry)) {
    console.log("Installing sharp (one-time, isolated)…");
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TOOLS_DIR, "package.json"), '{"name":"artgen-tools","private":true}\n');
    execSync("npm install sharp --no-save --no-audit --no-fund --no-workspaces", {
      cwd: TOOLS_DIR,
      stdio: "inherit"
    });
  }
  const requireFromTools = createRequire(path.join(TOOLS_DIR, "package.json"));
  return requireFromTools("sharp");
}

const COLOR_MOOD = {
  Green: "lush mossy greens and warm amber, earthy growth energy",
  Red: "fiery reds and molten orange, aggressive and hot",
  Blue: "cool teals and deep ocean blues, calm and controlling",
  Purple: "rich violets and arcane magenta, mystical and scoring",
  Colorless: "soft neutral bone-white and slate grey, understated"
};

function traitPrompt(card) {
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

function agePrompt(age) {
  return [
    `An evocative fantasy era scene representing the age "${age.name}".`,
    `Flavor: ${age.text || age.name}.`,
    `Style: sweeping painterly illustration, dramatic lighting, rich atmosphere,`,
    `storybook epic-fantasy mood matching a card game about evolving creatures.`,
    `Wide cinematic landscape framing, no characters required.`,
    `Absolutely no text, no letters, no numbers, no words, no UI, no border, no frame,`,
    `no watermark. Just the scene.`
  ].join(" ");
}

async function generateRaw(prompt) {
  const res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeManifest() {
  const ids = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".webp"))
    .map((f) => f.replace(/\.webp$/, ""))
    .sort();
  fs.writeFileSync(MANIFEST, `${JSON.stringify(ids)}\n`);
  console.log(`Manifest: ${ids.length} ids -> ${path.relative(ROOT, MANIFEST)}`);
}

async function main() {
  if (!API_KEY) {
    console.error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable.");
    process.exit(1);
  }

  const sharp = await loadSharp();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const data = JSON.parse(fs.readFileSync(CARDS, "utf8"));
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyTraits = args.includes("--traits");
  const onlyAges = args.includes("--ages");
  const idFilter = args.filter((a) => !a.startsWith("--"));

  let jobs = [];
  if (!onlyAges) {
    jobs.push(...(data.traits || []).map((c) => ({ id: c.id, name: c.name, prompt: traitPrompt(c) })));
  }
  if (!onlyTraits) {
    jobs.push(...(data.ages || []).map((a) => ({ id: a.id, name: a.name, prompt: agePrompt(a) })));
  }
  if (idFilter.length) {
    jobs = jobs.filter((j) => idFilter.includes(j.id));
  }
  if (!force) {
    jobs = jobs.filter((j) => !fs.existsSync(path.join(OUT_DIR, `${j.id}.webp`)));
  }

  console.log(`Model: ${MODEL}  |  WebP ${WEBP_WIDTH}px q${WEBP_QUALITY}`);
  console.log(`${jobs.length} image(s) to generate.`);

  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    const outPath = path.join(OUT_DIR, `${job.id}.webp`);
    let attempt = 0;
    while (attempt < 4) {
      attempt += 1;
      try {
        const raw = await generateRaw(job.prompt);
        const webp = await sharp(raw)
          .resize(WEBP_WIDTH, WEBP_WIDTH, { fit: "cover", position: "attention" })
          .webp({ quality: WEBP_QUALITY })
          .toBuffer();
        fs.writeFileSync(outPath, webp);
        done += 1;
        console.log(`  ✓ ${job.id}  ${job.name}  (${done}/${jobs.length}, ${(webp.length / 1024).toFixed(0)}KB)`);
        break;
      } catch (err) {
        if (attempt >= 4) {
          failed += 1;
          console.error(`  ✗ ${job.id}  ${job.name}  — ${err.message}`);
        } else {
          const wait = 1500 * attempt;
          console.warn(`  … ${job.id} retry ${attempt} after ${wait}ms — ${err.message}`);
          await sleep(wait);
        }
      }
    }
    await sleep(500);
  }

  writeManifest();
  console.log(`\nDone. ${done} generated, ${failed} failed. Art in ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
