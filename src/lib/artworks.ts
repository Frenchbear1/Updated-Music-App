import { db } from "./db";
import type { ArtworkFullBlobRecord, ArtworkRecord, ArtworkSource, EntityArtworkLink, Track, TrackArtworkLink } from "../types/media";

const ARTWORK_CACHE_DIR = "song_covers";
const FALLBACK_ARTWORK_TS = Date.now();

const FALLBACK_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#122538"/>
      <stop offset="100%" stop-color="#325b6f"/>
    </linearGradient>
  </defs>
  <rect width="640" height="640" fill="url(#g)"/>
  <circle cx="320" cy="320" r="210" fill="rgba(255,255,255,0.14)"/>
  <circle cx="320" cy="320" r="80" fill="rgba(255,255,255,0.28)"/>
</svg>
`;

export const DEFAULT_ARTWORK_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FALLBACK_SVG)}`;
export const DEFAULT_ARTWORK_PATH = `app-safe://localfiles/${ARTWORK_CACHE_DIR}/default-song-cover.webp?ts=${FALLBACK_ARTWORK_TS}`;

interface UrlCacheEntry {
  updatedAt: number;
  fullUrl?: string;
  optimizedUrl?: string;
}

interface NormalizedArtworkBlobData {
  fullBlob: Blob;
  optimizedBlob: Blob;
  width: number;
  height: number;
  optimizedWidth: number;
  optimizedHeight: number;
  mimeType: string;
  optimizedMimeType: string;
}

const objectUrlCache = new Map<string, UrlCacheEntry>();

const makeId = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `art_${Math.abs(hash).toString(36)}_${Date.now().toString(36)}`;
};

const cleanText = (value?: string): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const normalizeKey = (value?: string): string | null => {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalized ? normalized : null;
};

const splitArtists = (value?: string): string[] => {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return cleaned
    .split(/[,&;/]/g)
    .map((artist) => artist.trim())
    .filter((artist) => artist.length > 0);
};

const cleanupObjectUrls = (entry: UrlCacheEntry): void => {
  if (entry.fullUrl) URL.revokeObjectURL(entry.fullUrl);
  if (entry.optimizedUrl) URL.revokeObjectURL(entry.optimizedUrl);
};

const revokeArtworkUrlCacheForId = (artworkId: string): void => {
  const entry = objectUrlCache.get(artworkId);
  if (!entry) return;
  cleanupObjectUrls(entry);
  objectUrlCache.delete(artworkId);
};

const getOrCreateCacheEntry = (artworkId: string, updatedAt: number): UrlCacheEntry => {
  const cached = objectUrlCache.get(artworkId);
  if (cached && cached.updatedAt === updatedAt) {
    return cached;
  }
  if (cached) cleanupObjectUrls(cached);

  const nextEntry: UrlCacheEntry = { updatedAt };
  objectUrlCache.set(artworkId, nextEntry);
  return nextEntry;
};

const getCachedOptimizedArtworkBlobUrl = (record: ArtworkRecord): string => {
  const entry = getOrCreateCacheEntry(record.id, record.updatedAt);
  if (!entry.optimizedUrl) {
    entry.optimizedUrl = URL.createObjectURL(record.optimizedBlob);
  }
  return entry.optimizedUrl;
};

const getCachedFullArtworkBlobUrl = async (artworkId: string, updatedAt: number): Promise<string | null> => {
  const entry = getOrCreateCacheEntry(artworkId, updatedAt);
  if (entry.fullUrl) {
    return entry.fullUrl;
  }

  const fullBlobRecord = await db.artworkFullBlobs.get(artworkId);
  if (!fullBlobRecord) return null;

  const finalEntry = getOrCreateCacheEntry(artworkId, fullBlobRecord.updatedAt);
  if (!finalEntry.fullUrl) {
    finalEntry.fullUrl = URL.createObjectURL(fullBlobRecord.fullBlob);
  }
  return finalEntry.fullUrl;
};

const toAppSafeArtworkPath = (relativePath: string, timestamp: number): string => {
  return `app-safe://localfiles/${relativePath}?ts=${timestamp}`;
};

const asRenderableUrl = (objectUrl: string, timestamp: number): string => {
  return `${objectUrl}#ts=${timestamp}`;
};

const decodeArtworkBlob = async (
  blob: Blob
): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void; cleanup: () => void }> => {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
      cleanup: () => bitmap.close()
    };
  }

  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to decode artwork image"));
    image.src = objectUrl;
  });

  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    draw: (ctx, width, height) => ctx.drawImage(image, 0, 0, width, height),
    cleanup: () => URL.revokeObjectURL(objectUrl)
  };
};

const renderScaledBlob = async (
  source: { width: number; height: number; draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void },
  maxEdge: number,
  quality: number
): Promise<{ blob: Blob; width: number; height: number }> => {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable for artwork rendering");
  }

  source.draw(ctx, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", quality);
  });

  if (!blob) {
    throw new Error("Unable to encode artwork blob");
  }

  return { blob, width, height };
};

const normalizeArtworkBlob = async (inputBlob: Blob): Promise<NormalizedArtworkBlobData> => {
  const decoded = await decodeArtworkBlob(inputBlob);
  try {
    const full = await renderScaledBlob(decoded, 1400, 0.9);
    const optimized = await renderScaledBlob(decoded, 96, 0.72);
    return {
      fullBlob: full.blob,
      optimizedBlob: optimized.blob,
      width: full.width,
      height: full.height,
      optimizedWidth: optimized.width,
      optimizedHeight: optimized.height,
      mimeType: full.blob.type || "image/webp",
      optimizedMimeType: optimized.blob.type || "image/webp"
    };
  } finally {
    decoded.cleanup();
  }
};

const getArtworkEntityLinks = (track: Track, artworkId: string, now: number): EntityArtworkLink[] => {
  const links: EntityArtworkLink[] = [];
  const albumKey = normalizeKey(track.album);
  if (albumKey) {
    links.push({
      id: `album:${albumKey}:${track.id}`,
      entityType: "album",
      entityKey: albumKey,
      trackId: track.id,
      artworkId,
      createdAt: now,
      updatedAt: now
    });
  }

  const artistKeys = splitArtists(track.artist)
    .map((artist) => normalizeKey(artist))
    .filter((key): key is string => Boolean(key));
  for (const artistKey of artistKeys) {
    links.push({
      id: `artist:${artistKey}:${track.id}`,
      entityType: "artist",
      entityKey: artistKey,
      trackId: track.id,
      artworkId,
      createdAt: now,
      updatedAt: now
    });
  }

  for (const genre of track.genres ?? []) {
    const genreKey = normalizeKey(genre);
    if (!genreKey) continue;
    links.push({
      id: `genre:${genreKey}:${track.id}`,
      entityType: "genre",
      entityKey: genreKey,
      trackId: track.id,
      artworkId,
      createdAt: now,
      updatedAt: now
    });
  }

  return links;
};

const removeOrphanArtworks = async (artworkIds: string[]): Promise<void> => {
  const ids = Array.from(new Set(artworkIds.filter(Boolean)));
  for (const artworkId of ids) {
    const [trackLinks, entityLinks] = await Promise.all([
      db.trackArtworks.where("artworkId").equals(artworkId).count(),
      db.entityArtworks.where("artworkId").equals(artworkId).count()
    ]);
    if (trackLinks > 0 || entityLinks > 0) continue;
    await db.transaction("rw", db.artworks, db.artworkFullBlobs, async () => {
      await db.artworks.delete(artworkId);
      await db.artworkFullBlobs.delete(artworkId);
    });
    revokeArtworkUrlCacheForId(artworkId);
  }
};

const toTrackWithDefaultArtwork = (track: Track): Track => {
  return {
    ...track,
    artworkUrl: `${DEFAULT_ARTWORK_URL}#ts=${FALLBACK_ARTWORK_TS}`,
    artworkPath: DEFAULT_ARTWORK_PATH,
    artworkOptimizedPath: DEFAULT_ARTWORK_PATH,
    artworkSource: track.artworkSource,
    isDefaultArtwork: true
  };
};

export const hydrateTracksWithArtworkUrls = async (tracks: Track[]): Promise<Track[]> => {
  if (tracks.length === 0) return tracks;

  const artworkIds = Array.from(
    new Set(
      tracks
        .map((track) => track.artworkId)
        .filter((value): value is string => Boolean(value))
    )
  );

  const artworkRecords = artworkIds.length > 0 ? await db.artworks.bulkGet(artworkIds) : [];
  const artworkById = new Map<string, ArtworkRecord>();
  for (let index = 0; index < artworkIds.length; index += 1) {
    const record = artworkRecords[index];
    if (record) {
      artworkById.set(artworkIds[index], record);
    }
  }

  return tracks.map((track) => {
    const artworkId = track.artworkId;
    if (!artworkId) return toTrackWithDefaultArtwork(track);

    const record = artworkById.get(artworkId);
    if (!record) return toTrackWithDefaultArtwork(track);

    const timestamp = track.artworkUpdatedAt ?? record.updatedAt;
    const optimizedBlobUrl = getCachedOptimizedArtworkBlobUrl(record);

    return {
      ...track,
      artworkUrl: asRenderableUrl(optimizedBlobUrl, timestamp),
      artworkPath: toAppSafeArtworkPath(record.path, timestamp),
      artworkOptimizedPath: toAppSafeArtworkPath(record.optimizedPath, timestamp),
      artworkSource: track.artworkSource ?? record.source,
      artworkUpdatedAt: timestamp,
      isDefaultArtwork: false
    };
  });
};

export const hydrateTrackWithArtworkUrl = async (track: Track): Promise<Track> => {
  const hydrated = await hydrateTracksWithArtworkUrls([track]);
  return hydrated[0] ?? track;
};

export const resolveTrackArtworkUrl = async (
  track: Track,
  variant: "full" | "optimized" = "optimized"
): Promise<string | null> => {
  const artworkId = track.artworkId?.trim();
  if (!artworkId) return null;

  const record = await db.artworks.get(artworkId);
  if (!record) return null;

  const timestamp = track.artworkUpdatedAt ?? record.updatedAt;
  const blobUrl =
    variant === "full"
      ? await getCachedFullArtworkBlobUrl(record.id, record.updatedAt)
      : getCachedOptimizedArtworkBlobUrl(record);
  if (!blobUrl) return null;
  return asRenderableUrl(blobUrl, timestamp);
};

export const fetchArtworkBlobFromUrl = async (url: string, signal?: AbortSignal): Promise<Blob | null> => {
  const normalized = cleanText(url);
  if (!normalized) return null;
  try {
    const response = await fetch(normalized, { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return blob;
  } catch {
    return null;
  }
};

export const persistTrackArtwork = async (params: {
  track: Track;
  artworkBlob: Blob;
  source: ArtworkSource;
  now?: number;
}): Promise<Track> => {
  const now = params.now ?? Date.now();
  const normalized = await normalizeArtworkBlob(params.artworkBlob);
  const artworkId = makeId(`${params.track.id}:${now}:${params.source}`);
  const path = `${ARTWORK_CACHE_DIR}/${artworkId}.webp`;
  const optimizedPath = `${ARTWORK_CACHE_DIR}/${artworkId}-optimized.webp`;

  const artworkRecord: ArtworkRecord = {
    id: artworkId,
    source: params.source,
    path,
    optimizedPath,
    mimeType: normalized.mimeType,
    optimizedMimeType: normalized.optimizedMimeType,
    width: normalized.width,
    height: normalized.height,
    optimizedWidth: normalized.optimizedWidth,
    optimizedHeight: normalized.optimizedHeight,
    optimizedBlob: normalized.optimizedBlob,
    createdAt: now,
    updatedAt: now
  };
  const artworkFullBlobRecord: ArtworkFullBlobRecord = {
    id: artworkId,
    fullBlob: normalized.fullBlob,
    updatedAt: now
  };

  const previousLinks = await db.trackArtworks.where("trackId").equals(params.track.id).toArray();
  const previousArtworkIds = previousLinks.map((link) => link.artworkId);
  const trackWithArtwork: Track = {
    ...params.track,
    artworkId,
    artworkSource: params.source,
    artworkPath: path,
    artworkOptimizedPath: optimizedPath,
    artworkUpdatedAt: now,
    isDefaultArtwork: false,
    updatedAt: now
  };

  await db.transaction(
    "rw",
    ["artworks", "artworkFullBlobs", "trackArtworks", "entityArtworks", "tracks"],
    async () => {
      await db.artworks.put(artworkRecord);
      await db.artworkFullBlobs.put(artworkFullBlobRecord);

      await db.trackArtworks.where("trackId").equals(params.track.id).delete();
      await db.entityArtworks.where("trackId").equals(params.track.id).delete();

      const link: TrackArtworkLink = {
        trackId: params.track.id,
        artworkId,
        createdAt: now,
        updatedAt: now
      };
      await db.trackArtworks.put(link);

      const entityLinks = getArtworkEntityLinks(trackWithArtwork, artworkId, now);
      if (entityLinks.length > 0) {
        await db.entityArtworks.bulkPut(entityLinks);
      }

      await db.tracks.put(trackWithArtwork);
    }
  );

  if (previousArtworkIds.length > 0) {
    await removeOrphanArtworks(previousArtworkIds);
  }

  return hydrateTrackWithArtworkUrl(trackWithArtwork);
};

export const removeArtworkAssociationsForTracks = async (trackIds: string[]): Promise<void> => {
  if (trackIds.length === 0) return;
  const ids = Array.from(new Set(trackIds.filter(Boolean)));
  if (ids.length === 0) return;

  const previousLinks = await db.trackArtworks.where("trackId").anyOf(ids).toArray();
  const previousArtworkIds = previousLinks.map((link) => link.artworkId);

  await db.transaction("rw", db.trackArtworks, db.entityArtworks, async () => {
    await db.trackArtworks.where("trackId").anyOf(ids).delete();
    await db.entityArtworks.where("trackId").anyOf(ids).delete();
  });

  if (previousArtworkIds.length > 0) {
    await removeOrphanArtworks(previousArtworkIds);
  }
};

export const removeTrackArtwork = async (trackId: string): Promise<Track | null> => {
  const track = await db.tracks.get(trackId);
  if (!track) return null;

  const previousLinks = await db.trackArtworks.where("trackId").equals(trackId).toArray();
  const previousArtworkIds = previousLinks.map((link) => link.artworkId);

  const updatedTrack: Track = {
    ...track,
    artworkId: undefined,
    artworkSource: undefined,
    artworkPath: undefined,
    artworkOptimizedPath: undefined,
    artworkUpdatedAt: Date.now(),
    artworkUrl: undefined,
    isDefaultArtwork: true,
    updatedAt: Date.now()
  };

  await db.transaction("rw", db.trackArtworks, db.entityArtworks, db.tracks, async () => {
    await db.trackArtworks.where("trackId").equals(trackId).delete();
    await db.entityArtworks.where("trackId").equals(trackId).delete();
    await db.tracks.put(updatedTrack);
  });

  if (previousArtworkIds.length > 0) {
    await removeOrphanArtworks(previousArtworkIds);
  }

  return hydrateTrackWithArtworkUrl(updatedTrack);
};

export const releaseArtworkObjectUrls = (): void => {
  for (const entry of objectUrlCache.values()) {
    cleanupObjectUrls(entry);
  }
  objectUrlCache.clear();
};

export const releaseFullSizeArtworkObjectUrls = (keepArtworkId?: string): void => {
  const keepId = keepArtworkId?.trim();
  for (const [artworkId, entry] of objectUrlCache.entries()) {
    if (keepId && artworkId === keepId) continue;
    if (entry.fullUrl) {
      URL.revokeObjectURL(entry.fullUrl);
      entry.fullUrl = undefined;
    }
    if (!entry.fullUrl && !entry.optimizedUrl) {
      objectUrlCache.delete(artworkId);
    }
  }
};
