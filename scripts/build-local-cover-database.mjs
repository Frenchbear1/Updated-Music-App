import fs from "node:fs";
import path from "node:path";

const DEFAULT_INPUT_DIR = "offline-sources";
const DEFAULT_OUTPUT_DIR = "public/databases";

const args = process.argv.slice(2);

const getArgValue = (flag, fallback) => {
  const index = args.findIndex((item) => item === flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const inputDir = getArgValue("--input", DEFAULT_INPUT_DIR);
const outputDir = getArgValue("--output", DEFAULT_OUTPUT_DIR);

const readJsonArray = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${filePath}`);
  }
  return parsed;
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const normalizeString = (value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const acoustIdInputPath = path.join(inputDir, "acoustid.json");
const recordingsInputPath = path.join(inputDir, "musicbrainz-recordings.json");
const coverArtInputPath = path.join(inputDir, "coverart.json");

const acoustIdRows = readJsonArray(acoustIdInputPath);
const recordingRows = readJsonArray(recordingsInputPath);
const coverArtRows = readJsonArray(coverArtInputPath);

const acoustId = acoustIdRows
  .map((row) => ({
    fingerprint: normalizeString(row.fingerprint),
    recordingId: normalizeString(row.recordingId),
    score: typeof row.score === "number" ? row.score : undefined
  }))
  .filter((row) => row.fingerprint && row.recordingId)
  .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

const recordings = recordingRows
  .map((row) => ({
    recordingId: normalizeString(row.recordingId),
    releaseId: normalizeString(row.releaseId),
    title: normalizeString(row.title),
    artist: normalizeString(row.artist),
    album: normalizeString(row.album)
  }))
  .filter((row) => row.recordingId && row.title)
  .sort((a, b) => a.recordingId.localeCompare(b.recordingId));

const coverArt = coverArtRows
  .map((row) => ({
    releaseId: normalizeString(row.releaseId),
    artworkDataUrl: normalizeString(row.artworkDataUrl),
    artworkUrl: normalizeString(row.artworkUrl),
    artworkPath: normalizeString(row.artworkPath)
  }))
  .filter((row) => row.releaseId && (row.artworkDataUrl || row.artworkUrl || row.artworkPath))
  .sort((a, b) => a.releaseId.localeCompare(b.releaseId));

writeJson(path.join(outputDir, "acoustid.json"), acoustId);
writeJson(path.join(outputDir, "musicbrainz-recordings.json"), recordings);
writeJson(path.join(outputDir, "coverart.json"), coverArt);

const inputCoversDir = path.join(inputDir, "covers");
const outputCoversDir = path.join(outputDir, "covers");
fs.mkdirSync(outputCoversDir, { recursive: true });

if (fs.existsSync(inputCoversDir)) {
  const copied = new Set();
  for (const cover of coverArt) {
    const artworkPath = cover.artworkPath;
    if (!artworkPath) continue;
    if (artworkPath.startsWith("/") || artworkPath.startsWith("http://") || artworkPath.startsWith("https://") || artworkPath.startsWith("data:")) {
      continue;
    }
    if (copied.has(artworkPath)) continue;

    const sourcePath = path.join(inputCoversDir, artworkPath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const targetPath = path.join(outputCoversDir, artworkPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied.add(artworkPath);
  }
}

console.log(`Offline DB ready in ${outputDir}`);
console.log(`AcoustID rows: ${acoustId.length}`);
console.log(`MusicBrainz recording rows: ${recordings.length}`);
console.log(`Cover art rows: ${coverArt.length}`);

