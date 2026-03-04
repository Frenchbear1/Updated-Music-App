import { db } from "./db";
import { resolveArtworkFromLocalDatabase } from "./offlineMusicDb";
import { fetchArtworkBlobFromUrl, hydrateTrackWithArtworkUrl, hydrateTracksWithArtworkUrls, persistTrackArtwork, removeArtworkAssociationsForTracks, removeTrackArtwork } from "./artworks";
import { parseAudioFileMetadata } from "./embeddedMetadata";
import { searchSongMetadataResultsInInternet } from "./internetMetadata";
import type {
  AppDataClearTarget,
  ArtworkCacheEntry,
  ImportResult,
  LibrarySource,
  Playlist,
  RefreshResult,
  SongMetadataResultFromInternet,
  TrackFileBlobRecord,
  Track,
  TrashedSource,
  TrashedTrack
} from "../types/media";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);
const DELETE_CHUNK_SIZE = 250;
const APP_RECYCLE_DIRECTORY_NAME = "PulseDeck Trash";
const LEGACY_APP_RECYCLE_DIRECTORY_NAME = ".pulsedeck-recycle";

interface ScannedFile {
  name: string;
  artist: string;
  fileName: string;
  relativePath: string;
  pathHint: string;
}

interface ScannedInputFile extends ScannedFile {
  file: File;
}

const splitTitleArtist = (fileName: string): { title: string; artist: string } => {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const parts = base.split(" - ").map((item) => item.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const artist = parts[parts.length - 1];
    const title = parts.slice(0, -1).join(" - ");
    return {
      title: title || base,
      artist: artist || "Unknown Artist"
    };
  }
  return { title: base, artist: "Unknown Artist" };
};

const makeId = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return `id_${Math.abs(hash).toString(36)}_${value.length.toString(36)}`;
};

const isAudioFile = (name: string): boolean => {
  const ext = name.split(".").pop()?.toLowerCase();
  return Boolean(ext && AUDIO_EXTENSIONS.has(ext));
};

const isAudioInputFile = (file: File): boolean => {
  if (isAudioFile(file.name)) return true;
  return file.type?.toLowerCase().startsWith("audio/") ?? false;
};

const joinPath = (segments: string[]): string => segments.join("/");

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const normalizeRelativePath = (value: string): string => {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
};

const makeIgnoredTrackPathId = (sourceId: string, relativePath: string): string => {
  return `${sourceId}::${normalizeRelativePath(relativePath)}`;
};

const isAppRecycleDirectory = (name: string): boolean => {
  return name === APP_RECYCLE_DIRECTORY_NAME || name === LEGACY_APP_RECYCLE_DIRECTORY_NAME;
};

const buildIgnoredTrackPathRecords = (tracks: Track[]): Array<{ id: string; sourceId: string; relativePath: string; updatedAt: number }> => {
  const now = Date.now();
  const byId = new Map<string, { id: string; sourceId: string; relativePath: string; updatedAt: number }>();
  for (const track of tracks) {
    const normalizedPath = normalizeRelativePath(track.relativePath);
    if (!normalizedPath) continue;
    const id = makeIgnoredTrackPathId(track.sourceId, normalizedPath);
    byId.set(id, {
      id,
      sourceId: track.sourceId,
      relativePath: normalizedPath,
      updatedAt: now
    });
  }
  return Array.from(byId.values());
};

const buildIgnoredTrackPathIds = (tracks: Track[]): string[] => {
  return Array.from(
    new Set(
      tracks
        .map((track) => makeIgnoredTrackPathId(track.sourceId, track.relativePath))
        .filter((id) => Boolean(id))
    )
  );
};

const getIgnoredRelativePathSetForSource = async (sourceId: string): Promise<Set<string>> => {
  const ignored = await db.ignoredTrackPaths.where("sourceId").equals(sourceId).toArray();
  return new Set(
    ignored
      .map((entry) => normalizeRelativePath(entry.relativePath))
      .filter((relativePath) => Boolean(relativePath))
  );
};

const ensureUniqueRelativePath = (candidate: string, usedPaths: Set<string>): string => {
  const normalized = normalizeRelativePath(candidate);
  if (!normalized) {
    const fallback = `track-${usedPaths.size + 1}`;
    usedPaths.add(fallback);
    return fallback;
  }

  if (!usedPaths.has(normalized)) {
    usedPaths.add(normalized);
    return normalized;
  }

  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex <= 0) {
    let suffix = 1;
    let candidatePath = `${normalized} (${suffix})`;
    while (usedPaths.has(candidatePath)) {
      suffix += 1;
      candidatePath = `${normalized} (${suffix})`;
    }
    usedPaths.add(candidatePath);
    return candidatePath;
  }

  const name = normalized.slice(0, dotIndex);
  const ext = normalized.slice(dotIndex);
  let suffix = 1;
  let candidatePath = `${name} (${suffix})${ext}`;
  while (usedPaths.has(candidatePath)) {
    suffix += 1;
    candidatePath = `${name} (${suffix})${ext}`;
  }
  usedPaths.add(candidatePath);
  return candidatePath;
};

const scanRecursive = async (
  dirHandle: FileSystemDirectoryHandle,
  prefix: string[]
): Promise<ScannedFile[]> => {
  const items: ScannedFile[] = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && isAudioFile(name)) {
      const parsed = splitTitleArtist(name);
      const relativePath = joinPath([...prefix, name]);
      items.push({
        name: parsed.title,
        artist: parsed.artist,
        fileName: name,
        relativePath,
        pathHint: relativePath
      });
    }
    if (handle.kind === "directory") {
      if (isAppRecycleDirectory(name)) {
        continue;
      }
      const nested = await scanRecursive(handle as FileSystemDirectoryHandle, [...prefix, name]);
      items.push(...nested);
    }
  }
  return items;
};

const buildLibraryFromHandle = async (
  sourceId: string,
  rootName: string,
  rootHandle: FileSystemDirectoryHandle,
  favoriteByPath: Map<string, boolean>
): Promise<{ playlists: Playlist[]; tracks: Track[] }> => {
  const childDirectories: Array<{ name: string; handle: FileSystemDirectoryHandle }> = [];
  const rootFiles: ScannedFile[] = [];

  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind === "directory") {
      if (isAppRecycleDirectory(name)) {
        continue;
      }
      childDirectories.push({ name, handle: handle as FileSystemDirectoryHandle });
    }
    if (handle.kind === "file" && isAudioFile(name)) {
      const parsed = splitTitleArtist(name);
      rootFiles.push({
        name: parsed.title,
        artist: parsed.artist,
        fileName: name,
        relativePath: name,
        pathHint: name
      });
    }
  }

  const childScans = await Promise.all(
    childDirectories.map(async ({ name, handle }) => ({
      name,
      tracks: await scanRecursive(handle, [name])
    }))
  );

  const hasChildPlaylists = childScans.some((entry) => entry.tracks.length > 0);
  const playlists: Playlist[] = [];
  const tracks: Track[] = [];
  const updatedAt = Date.now();
  let orderCursor = 0;

  if (hasChildPlaylists) {
    if (rootFiles.length > 0) {
      const playlistId = makeId(`${sourceId}:${rootName}`);
      const playlistTracks = rootFiles.map((item) => {
        const id = makeId(`${playlistId}:${item.relativePath}`);
        const favorite = favoriteByPath.get(item.relativePath) ?? false;
        return {
          id,
          playlistId,
          sourceId,
          name: item.name,
          artist: item.artist,
          album: rootName,
          fileName: item.fileName,
          pathHint: item.pathHint,
          relativePath: item.relativePath,
          favorite,
          updatedAt
        } satisfies Track;
      });

      playlists.push({
        id: playlistId,
        sourceId,
        name: rootName,
        sourceType: "root",
        trackIds: playlistTracks.map((item) => item.id),
        order: orderCursor,
        updatedAt
      });
      orderCursor += 1;
      tracks.push(...playlistTracks);
    }

    for (const child of childScans) {
      if (child.tracks.length === 0) continue;
      const playlistId = makeId(`${sourceId}:${child.name}`);
      const playlistTracks = child.tracks.map((item) => {
        const id = makeId(`${playlistId}:${item.relativePath}`);
        const favorite = favoriteByPath.get(item.relativePath) ?? false;
        return {
          id,
          playlistId,
          sourceId,
          name: item.name,
          artist: item.artist,
          album: child.name,
          fileName: item.fileName,
          pathHint: item.pathHint,
          relativePath: item.relativePath,
          favorite,
          updatedAt
        } satisfies Track;
      });

      playlists.push({
        id: playlistId,
        sourceId,
        name: child.name,
        sourceType: "child",
        trackIds: playlistTracks.map((item) => item.id),
        order: orderCursor,
        updatedAt
      });
      orderCursor += 1;
      tracks.push(...playlistTracks);
    }
  } else {
    const nestedRootFiles = await Promise.all(
      childDirectories.map(({ name, handle }) => scanRecursive(handle, [name]))
    );
    const merged = [...rootFiles, ...nestedRootFiles.flat()];

    if (merged.length > 0) {
      const playlistId = makeId(`${sourceId}:${rootName}`);
      const playlistTracks = merged.map((item) => {
        const id = makeId(`${playlistId}:${item.relativePath}`);
        const favorite = favoriteByPath.get(item.relativePath) ?? false;
        return {
          id,
          playlistId,
          sourceId,
          name: item.name,
          artist: item.artist,
          album: rootName,
          fileName: item.fileName,
          pathHint: item.pathHint,
          relativePath: item.relativePath,
          favorite,
          updatedAt
        } satisfies Track;
      });

      playlists.push({
        id: playlistId,
        sourceId,
        name: rootName,
        sourceType: "root",
        trackIds: playlistTracks.map((item) => item.id),
        order: orderCursor,
        updatedAt
      });
      tracks.push(...playlistTracks);
    }
  }

  return { playlists, tracks };
};

const buildLibraryFromInputFiles = (
  sourceId: string,
  sourceName: string,
  files: File[]
): { playlists: Playlist[]; tracks: Track[]; filesByTrackId: Map<string, File> } => {
  const updatedAt = Date.now();
  const playlistId = makeId(`${sourceId}:${sourceName}`);
  const usedPaths = new Set<string>();
  const scannedFiles: ScannedInputFile[] = [];

  for (const file of files) {
    if (!isAudioInputFile(file)) continue;
    const parsed = splitTitleArtist(file.name);
    const rawRelativePath = normalizeRelativePath(file.webkitRelativePath?.trim() || file.name.trim());
    const relativePath = ensureUniqueRelativePath(rawRelativePath || file.name, usedPaths);

    scannedFiles.push({
      file,
      name: parsed.title,
      artist: parsed.artist,
      fileName: file.name,
      relativePath,
      pathHint: relativePath
    });
  }

  if (scannedFiles.length === 0) {
    throw new Error("No supported audio files were selected");
  }

  const filesByTrackId = new Map<string, File>();
  const tracks: Track[] = scannedFiles.map((item) => {
    const id = makeId(`${playlistId}:${item.relativePath}`);
    filesByTrackId.set(id, item.file);
    return {
      id,
      playlistId,
      sourceId,
      name: item.name,
      artist: item.artist,
      album: sourceName,
      fileName: item.fileName,
      pathHint: item.pathHint,
      relativePath: item.relativePath,
      favorite: false,
      updatedAt
    } satisfies Track;
  });

  const playlists: Playlist[] = [
    {
      id: playlistId,
      sourceId,
      name: sourceName,
      sourceType: "root",
      trackIds: tracks.map((item) => item.id),
      order: 0,
      updatedAt
    }
  ];

  return { playlists, tracks, filesByTrackId };
};

const enrichTracksWithEmbeddedMetadata = async (
  rootHandle: FileSystemDirectoryHandle,
  scannedTracks: Track[],
  previousTrackByPath?: Map<string, Track>
): Promise<{ tracks: Track[]; localArtworks: Map<string, Blob> }> => {
  const localArtworks = new Map<string, Blob>();
  const enrichedTracks: Track[] = [];

  for (const track of scannedTracks) {
    const previous = previousTrackByPath?.get(track.relativePath);
    let nextTrack: Track = {
      ...track,
      artworkId: previous?.artworkId,
      artworkSource: previous?.artworkSource,
      artworkPath: previous?.artworkPath,
      artworkOptimizedPath: previous?.artworkOptimizedPath,
      artworkUpdatedAt: previous?.artworkUpdatedAt,
      artworkCandidateUrl: previous?.artworkCandidateUrl,
      acoustIdFingerprint: previous?.acoustIdFingerprint,
      musicBrainzRecordingId: previous?.musicBrainzRecordingId,
      musicBrainzReleaseId: previous?.musicBrainzReleaseId,
      genres: previous?.genres,
      durationSec: previous?.durationSec
    };

    try {
      const fileHandle = await resolveFileHandleByRelativePath(rootHandle, track.relativePath);
      if (!fileHandle) {
        enrichedTracks.push(nextTrack);
        continue;
      }

      const file = await fileHandle.getFile();
      const parsedMetadata = await parseAudioFileMetadata(file);

      nextTrack = {
        ...nextTrack,
        name: parsedMetadata.title || nextTrack.name,
        artist: parsedMetadata.artist || nextTrack.artist,
        album: parsedMetadata.album || nextTrack.album,
        genres: parsedMetadata.genres && parsedMetadata.genres.length > 0 ? parsedMetadata.genres : nextTrack.genres,
        durationSec:
          typeof parsedMetadata.durationSec === "number" && Number.isFinite(parsedMetadata.durationSec) && parsedMetadata.durationSec > 0
            ? parsedMetadata.durationSec
            : nextTrack.durationSec
      };

      if (parsedMetadata.artwork?.blob) {
        localArtworks.set(track.id, parsedMetadata.artwork.blob);
      }
    } catch {
      // Keep scan resilient: metadata extraction failures should not block import.
    }

    enrichedTracks.push(nextTrack);
  }

  return { tracks: enrichedTracks, localArtworks };
};

const enrichTracksWithEmbeddedMetadataFromInputFiles = async (
  scannedTracks: Track[],
  filesByTrackId: Map<string, File>
): Promise<{ tracks: Track[]; localArtworks: Map<string, Blob>; trackFileBlobs: TrackFileBlobRecord[] }> => {
  const localArtworks = new Map<string, Blob>();
  const enrichedTracks: Track[] = [];
  const trackFileBlobs: TrackFileBlobRecord[] = [];
  const updatedAt = Date.now();

  for (const track of scannedTracks) {
    const sourceFile = filesByTrackId.get(track.id);
    if (!sourceFile) continue;

    let nextTrack: Track = track;
    try {
      const parsedMetadata = await parseAudioFileMetadata(sourceFile);
      nextTrack = {
        ...track,
        name: parsedMetadata.title || track.name,
        artist: parsedMetadata.artist || track.artist,
        album: parsedMetadata.album || track.album,
        genres: parsedMetadata.genres && parsedMetadata.genres.length > 0 ? parsedMetadata.genres : track.genres,
        durationSec:
          typeof parsedMetadata.durationSec === "number" && Number.isFinite(parsedMetadata.durationSec) && parsedMetadata.durationSec > 0
            ? parsedMetadata.durationSec
            : track.durationSec
      };

      if (parsedMetadata.artwork?.blob) {
        localArtworks.set(track.id, parsedMetadata.artwork.blob);
      }
    } catch {
      // Keep scan resilient: metadata extraction failures should not block import.
    }

    trackFileBlobs.push({
      trackId: track.id,
      fileBlob: sourceFile,
      updatedAt
    });
    enrichedTracks.push(nextTrack);
  }

  return { tracks: enrichedTracks, localArtworks, trackFileBlobs };
};

export const getLibrary = async (): Promise<{
  sources: LibrarySource[];
  playlists: Playlist[];
  tracks: Track[];
}> => {
  const [sources, playlists, rawTracks] = await Promise.all([
    db.sources.toArray(),
    db.playlists.toArray(),
    db.tracks.toArray()
  ]);
  const tracks = await hydrateTracksWithArtworkUrls(rawTracks);

  return {
    sources: sources.sort((a, b) => a.name.localeCompare(b.name)),
    playlists: playlists.sort((a, b) => {
      if (a.sourceId !== b.sourceId) return a.sourceId.localeCompare(b.sourceId);
      const orderDelta = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
      if (orderDelta !== 0) return orderDelta;
      return a.name.localeCompare(b.name);
    }),
    tracks
  };
};

export const importFolder = async (): Promise<ImportResult> => {
  const rootHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const now = Date.now();
  const sourceId = makeId(`source:${rootHandle.name}:${now}`);
  const handleKey = makeId(`handle:${sourceId}`);

  const source: LibrarySource = {
    id: sourceId,
    name: rootHandle.name,
    handleKey,
    importType: "folder",
    createdAt: now,
    updatedAt: now
  };

  const { playlists, tracks: scannedTracks } = await buildLibraryFromHandle(sourceId, rootHandle.name, rootHandle, new Map());
  const { tracks: metadataTracks, localArtworks } = await enrichTracksWithEmbeddedMetadata(rootHandle, scannedTracks);
  const tracks = await applyOfflineArtworkDatabase(await applyGlobalArtworkCache(metadataTracks));

  await db.transaction("rw", db.sources, db.playlists, db.tracks, db.folderHandles, async () => {
    await db.sources.put(source);
    await db.folderHandles.put({ handleKey, handle: rootHandle });
    await db.playlists.bulkPut(playlists);
    await db.tracks.bulkPut(tracks);
  });

  if (localArtworks.size > 0) {
    for (const track of tracks) {
      const artworkBlob = localArtworks.get(track.id);
      if (!artworkBlob) continue;
      await persistTrackArtwork({
        track,
        artworkBlob,
        source: "LOCAL"
      });
    }
  }

  const persistedTracks = await db.tracks.where("sourceId").equals(sourceId).toArray();
  return { source, playlists, tracks: await hydrateTracksWithArtworkUrls(persistedTracks) };
};

export const importFiles = async (files: File[]): Promise<ImportResult> => {
  const audioFiles = files.filter((file) => isAudioInputFile(file));
  if (audioFiles.length === 0) {
    throw new Error("No supported audio files were selected");
  }

  const now = Date.now();
  const sourceName =
    normalizeImportString(audioFiles[0]?.webkitRelativePath?.split("/").filter(Boolean)[0]) || `Imported files ${new Date(now).toLocaleDateString()}`;
  const sourceIdentity = audioFiles
    .slice(0, 6)
    .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
    .join("|");
  const sourceId = makeId(`source:files:${sourceName}:${now}:${audioFiles.length}:${sourceIdentity}`);
  const handleKey = makeId(`files:${sourceId}`);

  const source: LibrarySource = {
    id: sourceId,
    name: sourceName,
    handleKey,
    importType: "files",
    createdAt: now,
    updatedAt: now
  };

  const { playlists, tracks: scannedTracks, filesByTrackId } = buildLibraryFromInputFiles(sourceId, sourceName, audioFiles);
  const { tracks: metadataTracks, localArtworks, trackFileBlobs } = await enrichTracksWithEmbeddedMetadataFromInputFiles(scannedTracks, filesByTrackId);
  const tracks = await applyOfflineArtworkDatabase(await applyGlobalArtworkCache(metadataTracks));

  await db.transaction("rw", db.sources, db.playlists, db.tracks, db.trackFileBlobs, async () => {
    await db.sources.put(source);
    await db.playlists.bulkPut(playlists);
    await db.tracks.bulkPut(tracks);
    await db.trackFileBlobs.bulkPut(trackFileBlobs);
  });

  if (localArtworks.size > 0) {
    for (const track of tracks) {
      const artworkBlob = localArtworks.get(track.id);
      if (!artworkBlob) continue;
      await persistTrackArtwork({
        track,
        artworkBlob,
        source: "LOCAL"
      });
    }
  }

  const persistedTracks = await db.tracks.where("sourceId").equals(sourceId).toArray();
  return { source, playlists, tracks: await hydrateTracksWithArtworkUrls(persistedTracks) };
};

const getTopLevelFolderNameFromWebkitPath = (file: File): string | null => {
  const normalizedPath = normalizeImportString(file.webkitRelativePath);
  if (!normalizedPath) return null;

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return segments[0] ?? null;
};

const groupFilesByTopLevelFolder = (files: File[]): File[][] => {
  const groupedByFolder = new Map<string, File[]>();
  const looseFiles: File[] = [];

  for (const file of files) {
    const folderName = getTopLevelFolderNameFromWebkitPath(file);
    if (!folderName) {
      looseFiles.push(file);
      continue;
    }

    const existing = groupedByFolder.get(folderName);
    if (existing) {
      existing.push(file);
    } else {
      groupedByFolder.set(folderName, [file]);
    }
  }

  const groups = Array.from(groupedByFolder.values());
  if (looseFiles.length > 0) {
    groups.push(looseFiles);
  }
  return groups;
};

export const importFilesBulk = async (files: File[]): Promise<{ sources: number; tracks: number }> => {
  const audioFiles = files.filter((file) => isAudioInputFile(file));
  if (audioFiles.length === 0) {
    throw new Error("No supported audio files were selected");
  }

  const groupedFiles = groupFilesByTopLevelFolder(audioFiles);
  let importedSourceCount = 0;
  let importedTrackCount = 0;

  for (const fileGroup of groupedFiles) {
    const imported = await importFiles(fileGroup);
    importedSourceCount += 1;
    importedTrackCount += imported.tracks.length;
  }

  return {
    sources: importedSourceCount,
    tracks: importedTrackCount
  };
};

export const refreshSource = async (sourceId: string): Promise<RefreshResult> => {
  const source = await db.sources.get(sourceId);
  if (!source) {
    throw new Error("Source not found");
  }
  if (source.importType === "files") {
    throw new Error("This source was imported from files. Re-import files to refresh it.");
  }

  const handleRecord = await db.folderHandles.get(source.handleKey);
  if (!handleRecord) {
    throw new Error("Folder handle missing, re-import the folder");
  }

  const permission = await handleRecord.handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    const result = await handleRecord.handle.requestPermission({ mode: "readwrite" });
    if (result !== "granted") {
      throw new Error("Folder permission was not granted");
    }
  }

  const [oldTracks, oldPlaylists] = await Promise.all([
    db.tracks.where("sourceId").equals(sourceId).toArray(),
    db.playlists.where("sourceId").equals(sourceId).toArray()
  ]);
  const favoriteByPath = new Map(oldTracks.map((track) => [track.relativePath, track.favorite]));
  const previousTrackByPath = new Map(oldTracks.map((track) => [track.relativePath, track]));
  const { playlists: scannedPlaylists, tracks: allScannedTracks } = await buildLibraryFromHandle(
    source.id,
    source.name,
    handleRecord.handle,
    favoriteByPath
  );
  const ignoredRelativePaths = await getIgnoredRelativePathSetForSource(source.id);
  const scannedTracks =
    ignoredRelativePaths.size === 0
      ? allScannedTracks
      : allScannedTracks.filter((track) => !ignoredRelativePaths.has(normalizeRelativePath(track.relativePath)));
  const scannedTrackIds = new Set(scannedTracks.map((track) => track.id));
  const playlists = scannedPlaylists
    .map((playlist) => ({
      ...playlist,
      trackIds: playlist.trackIds.filter((trackId) => scannedTrackIds.has(trackId))
    }))
    .filter((playlist) => playlist.trackIds.length > 0);

  const { tracks: metadataTracks, localArtworks } = await enrichTracksWithEmbeddedMetadata(
    handleRecord.handle,
    scannedTracks,
    previousTrackByPath
  );
  const tracks = await applyOfflineArtworkDatabase(
    await applyGlobalArtworkCache(
      metadataTracks.map((track) => {
        const previous = previousTrackByPath.get(track.relativePath);
        if (!previous) return track;
        return {
          ...track,
          album: previous.album ?? track.album,
          genres: previous.genres ?? track.genres,
          artworkCandidateUrl: previous.artworkCandidateUrl ?? track.artworkCandidateUrl,
          artworkId: previous.artworkId ?? track.artworkId,
          artworkSource: previous.artworkSource ?? track.artworkSource,
          artworkPath: previous.artworkPath ?? track.artworkPath,
          artworkOptimizedPath: previous.artworkOptimizedPath ?? track.artworkOptimizedPath,
          artworkUpdatedAt: previous.artworkUpdatedAt ?? track.artworkUpdatedAt,
          acoustIdFingerprint: previous.acoustIdFingerprint ?? track.acoustIdFingerprint,
          musicBrainzRecordingId: previous.musicBrainzRecordingId ?? track.musicBrainzRecordingId,
          musicBrainzReleaseId: previous.musicBrainzReleaseId ?? track.musicBrainzReleaseId,
          durationSec: previous.durationSec ?? track.durationSec
        };
      })
    )
  );
  const previousOrder = new Map(oldPlaylists.map((playlist) => [playlist.id, playlist.order ?? Number.MAX_SAFE_INTEGER]));
  let nextOrder = oldPlaylists.length;
  for (const playlist of playlists) {
    const existing = previousOrder.get(playlist.id);
    if (existing !== undefined && Number.isFinite(existing)) {
      playlist.order = existing;
    } else {
      playlist.order = nextOrder;
      nextOrder += 1;
    }
  }
  const updatedSource = { ...source, updatedAt: Date.now() };

  await db.transaction("rw", db.sources, db.playlists, db.tracks, async () => {
    await db.sources.put(updatedSource);
    await db.playlists.where("sourceId").equals(sourceId).delete();
    await db.tracks.where("sourceId").equals(sourceId).delete();
    if (playlists.length > 0) await db.playlists.bulkPut(playlists);
    if (tracks.length > 0) await db.tracks.bulkPut(tracks);
  });

  if (localArtworks.size > 0) {
    for (const track of tracks) {
      const artworkBlob = localArtworks.get(track.id);
      if (!artworkBlob) continue;
      await persistTrackArtwork({
        track,
        artworkBlob,
        source: "LOCAL"
      });
    }
  }

  return {
    source: updatedSource,
    playlists,
    tracks: await hydrateTracksWithArtworkUrls(await db.tracks.where("sourceId").equals(sourceId).toArray())
  };
};

const isNotFoundError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === "NotFoundError";
};

const resolveSourceHandleWithPermission = async (
  source: LibrarySource,
  mode: "read" | "readwrite"
): Promise<FileSystemDirectoryHandle> => {
  const handleRecord = await db.folderHandles.get(source.handleKey);
  if (!handleRecord) {
    throw new Error("Folder handle missing, re-import the folder");
  }

  const permission = await handleRecord.handle.queryPermission({ mode });
  if (permission !== "granted") {
    const result = await handleRecord.handle.requestPermission({ mode });
    if (result !== "granted") {
      throw new Error(mode === "readwrite" ? "Folder delete permission denied" : "Read permission denied for this folder");
    }
  }

  return handleRecord.handle;
};

const splitFileName = (fileName: string): { base: string; ext: string } => {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, dotIndex),
    ext: fileName.slice(dotIndex)
  };
};

const ensureUniqueFileNameInDirectory = async (
  directory: FileSystemDirectoryHandle,
  fileName: string
): Promise<string> => {
  let candidate = fileName;
  let suffix = 1;
  const { base, ext } = splitFileName(fileName);

  while (true) {
    try {
      await directory.getFileHandle(candidate);
      candidate = `${base} (${suffix})${ext}`;
      suffix += 1;
    } catch (error) {
      if (isNotFoundError(error)) {
        return candidate;
      }
      throw error;
    }
  }
};

const moveRelativeFileToRecycleFolder = async (
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<void> => {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return;

  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) return;

  let sourceDirectory = rootHandle;
  try {
    for (const segment of segments) {
      sourceDirectory = await sourceDirectory.getDirectoryHandle(segment);
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  let sourceFileHandle: FileSystemFileHandle;
  try {
    sourceFileHandle = await sourceDirectory.getFileHandle(fileName);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  const recycleDirectory = await sourceDirectory.getDirectoryHandle(APP_RECYCLE_DIRECTORY_NAME, { create: true });
  const uniqueName = await ensureUniqueFileNameInDirectory(recycleDirectory, fileName);
  const targetHandle = await recycleDirectory.getFileHandle(uniqueName, { create: true });
  const sourceFile = await sourceFileHandle.getFile();
  const writable = await targetHandle.createWritable();
  try {
    await writable.write(sourceFile);
  } finally {
    await writable.close();
  }

  await sourceDirectory.removeEntry(fileName);
};

const moveTracksToRecycleFolder = async (
  rootHandle: FileSystemDirectoryHandle,
  tracks: Track[]
): Promise<void> => {
  if (tracks.length === 0) return;
  for (const track of tracks) {
    await moveRelativeFileToRecycleFolder(rootHandle, track.relativePath);
  }
};

const deletePlaylistLocalContentsFromRoot = async (
  rootHandle: FileSystemDirectoryHandle,
  playlistTracks: Track[]
): Promise<void> => {
  await moveTracksToRecycleFolder(rootHandle, playlistTracks);
};

const deletePlaylistLocalContents = async (
  source: LibrarySource,
  playlistTracks: Track[]
): Promise<void> => {
  if (source.importType === "files") {
    return;
  }

  const rootHandle = await resolveSourceHandleWithPermission(source, "readwrite");
  await deletePlaylistLocalContentsFromRoot(rootHandle, playlistTracks);
};

export const removeSource = async (sourceId: string, mode: "unlink" | "delete"): Promise<void> => {
  const source = await db.sources.get(sourceId);
  if (!source) return;
  const sourceTracks = await db.tracks.where("sourceId").equals(sourceId).toArray();

  if (mode === "delete" && source.importType !== "files") {
    const rootHandle = await resolveSourceHandleWithPermission(source, "readwrite");
    await moveTracksToRecycleFolder(rootHandle, sourceTracks);
  }

  if (sourceTracks.length > 0) {
    await removeArtworkAssociationsForTracks(sourceTracks.map((track) => track.id));
  }

  await db.transaction("rw", [db.sources, db.playlists, db.tracks, db.folderHandles, db.trackFileBlobs], async () => {
    await db.playlists.where("sourceId").equals(sourceId).delete();
    await db.tracks.where("sourceId").equals(sourceId).delete();
    await db.sources.delete(sourceId);
    await db.folderHandles.delete(source.handleKey);
    for (const track of sourceTracks) {
      await db.trackFileBlobs.delete(track.id);
    }
  });
};

export const removePlaylist = async (playlistId: string, mode: "unlink" | "delete"): Promise<void> => {
  const playlist = await db.playlists.get(playlistId);
  if (!playlist) return;

  const source = await db.sources.get(playlist.sourceId);
  if (!source) {
    throw new Error("Folder source not found");
  }

  const playlistTracks = await db.tracks.where("playlistId").equals(playlistId).toArray();

  if (mode === "delete") {
    await deletePlaylistLocalContents(source, playlistTracks);
  }

  if (playlistTracks.length > 0) {
    await removeArtworkAssociationsForTracks(playlistTracks.map((track) => track.id));
  }

  await db.transaction("rw", [db.sources, db.playlists, db.tracks, db.folderHandles, db.trackFileBlobs], async () => {
    await db.playlists.delete(playlistId);
    if (playlistTracks.length > 0) {
      await db.tracks.bulkDelete(playlistTracks.map((track) => track.id));
      for (const track of playlistTracks) {
        await db.trackFileBlobs.delete(track.id);
      }
    }

    const remainingPlaylistCount = await db.playlists.where("sourceId").equals(playlist.sourceId).count();
    if (remainingPlaylistCount === 0) {
      await db.sources.delete(source.id);
      await db.folderHandles.delete(source.handleKey);
    }
  });
};

const makeTrashId = (prefix: string, id: string): string => `${prefix}_${id}_${Date.now().toString(36)}`;

export const getTrash = async (): Promise<{ sources: TrashedSource[]; tracks: TrashedTrack[] }> => {
  const [sources, tracks] = await Promise.all([db.trashedSources.toArray(), db.trashedTracks.toArray()]);
  return {
    sources: sources.sort((a, b) => b.trashedAt - a.trashedAt),
    tracks: tracks.sort((a, b) => b.trashedAt - a.trashedAt)
  };
};

export const trashSource = async (sourceId: string): Promise<void> => {
  const source = await db.sources.get(sourceId);
  if (!source) return;

  const [playlists, tracks] = await Promise.all([
    db.playlists.where("sourceId").equals(sourceId).toArray(),
    db.tracks.where("sourceId").equals(sourceId).toArray()
  ]);

  const trashedSource: TrashedSource = {
    id: makeTrashId("source", sourceId),
    source,
    playlists,
    tracks,
    trashedAt: Date.now()
  };

  await db.transaction("rw", db.sources, db.playlists, db.tracks, db.trashedSources, async () => {
    await db.trashedSources.put(trashedSource);
    await db.playlists.where("sourceId").equals(sourceId).delete();
    await db.tracks.where("sourceId").equals(sourceId).delete();
    await db.sources.delete(sourceId);
  });
};

export const trashPlaylist = async (playlistId: string): Promise<void> => {
  const playlist = await db.playlists.get(playlistId);
  if (!playlist) return;

  const source = await db.sources.get(playlist.sourceId);
  if (!source) {
    throw new Error("Folder source not found");
  }

  const tracks = await db.tracks.where("playlistId").equals(playlistId).toArray();
  const trashedSource: TrashedSource = {
    id: makeTrashId("playlist", playlistId),
    source,
    playlists: [playlist],
    tracks,
    trashedAt: Date.now()
  };
  const ignoredTrackPathRecords = buildIgnoredTrackPathRecords(tracks);

  await db.transaction("rw", [db.sources, db.playlists, db.tracks, db.trashedSources, db.ignoredTrackPaths], async () => {
    await db.trashedSources.put(trashedSource);
    if (ignoredTrackPathRecords.length > 0) {
      await db.ignoredTrackPaths.bulkPut(ignoredTrackPathRecords);
    }
    await db.playlists.delete(playlistId);
    if (tracks.length > 0) {
      await db.tracks.bulkDelete(tracks.map((track) => track.id));
    }

    const remainingPlaylistCount = await db.playlists.where("sourceId").equals(source.id).count();
    if (remainingPlaylistCount === 0) {
      await db.sources.delete(source.id);
    }
  });
};

export const restoreTrashedSource = async (trashId: string): Promise<void> => {
  const trashed = await db.trashedSources.get(trashId);
  if (!trashed) return;
  const ignoredTrackPathIds = buildIgnoredTrackPathIds(trashed.tracks);

  await db.transaction("rw", [db.sources, db.playlists, db.tracks, db.trashedSources, db.ignoredTrackPaths], async () => {
    const existingSource = await db.sources.get(trashed.source.id);
    if (!existingSource) {
      await db.sources.put(trashed.source);
    }
    if (trashed.playlists.length > 0) {
      await db.playlists.bulkPut(trashed.playlists);
    }
    if (trashed.tracks.length > 0) {
      await db.tracks.bulkPut(trashed.tracks);
    }
    if (ignoredTrackPathIds.length > 0) {
      await db.ignoredTrackPaths.bulkDelete(ignoredTrackPathIds);
    }
    await db.trashedSources.delete(trashId);
  });
};

const resolveTrackParentDirectory = async (
  sourceId: string,
  relativePath: string,
  mode: "read" | "readwrite"
): Promise<{ directory: FileSystemDirectoryHandle; fileName: string }> => {
  const source = await db.sources.get(sourceId);
  if (!source) {
    throw new Error("Track source not found");
  }

  const handleRecord = await db.folderHandles.get(source.handleKey);
  if (!handleRecord) {
    throw new Error("Folder handle not found, re-import the source folder");
  }

  const permission = await handleRecord.handle.queryPermission({ mode });
  if (permission !== "granted") {
    const result = await handleRecord.handle.requestPermission({ mode });
    if (result !== "granted") {
      throw new Error(mode === "readwrite" ? "Write permission denied for this folder" : "Read permission denied for this folder");
    }
  }

  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) {
    throw new Error("Invalid track path");
  }

  let directory: FileSystemDirectoryHandle = handleRecord.handle;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment);
  }

  return { directory, fileName };
};

export const removeTrack = async (trackId: string, mode: "unlink" | "delete"): Promise<void> => {
  const track = await db.tracks.get(trackId);
  if (!track) return;
  const source = await db.sources.get(track.sourceId);

  if (mode === "delete" && source && source.importType !== "files") {
    const { directory, fileName } = await resolveTrackParentDirectory(track.sourceId, track.relativePath, "readwrite");
    await directory.removeEntry(fileName);
    await removeArtworkAssociationsForTracks([trackId]);
  } else {
    await removeArtworkAssociationsForTracks([trackId]);
  }

  await db.transaction("rw", db.tracks, db.playlists, db.trackFileBlobs, async () => {
    await db.tracks.delete(trackId);
    await db.trackFileBlobs.delete(trackId);
    const playlist = await db.playlists.get(track.playlistId);
    if (!playlist) return;
    const nextTrackIds = playlist.trackIds.filter((id) => id !== trackId);
    await db.playlists.put({
      ...playlist,
      trackIds: nextTrackIds,
      updatedAt: Date.now()
    });
  });
};

export const trashTrack = async (trackId: string): Promise<void> => {
  const track = await db.tracks.get(trackId);
  if (!track) return;

  const [source, playlist] = await Promise.all([db.sources.get(track.sourceId), db.playlists.get(track.playlistId)]);
  if (!playlist) {
    throw new Error("Track playlist not found");
  }

  const trashedTrack: TrashedTrack = {
    id: makeTrashId("track", track.id),
    track,
    sourceName: source?.name ?? "Unknown Folder",
    playlistName: playlist.name,
    trashedAt: Date.now()
  };
  const ignoredTrackPathId = makeIgnoredTrackPathId(track.sourceId, track.relativePath);

  await db.transaction("rw", db.tracks, db.playlists, db.trashedTracks, db.ignoredTrackPaths, async () => {
    await db.trashedTracks.put(trashedTrack);
    await db.ignoredTrackPaths.put({
      id: ignoredTrackPathId,
      sourceId: track.sourceId,
      relativePath: normalizeRelativePath(track.relativePath),
      updatedAt: Date.now()
    });
    await db.tracks.delete(trackId);
    await db.playlists.put({
      ...playlist,
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      updatedAt: Date.now()
    });
  });
};

export const restoreTrashedTrack = async (trashId: string): Promise<void> => {
  const trashed = await db.trashedTracks.get(trashId);
  if (!trashed) return;

  const playlist = await db.playlists.get(trashed.track.playlistId);
  if (!playlist) {
    throw new Error("Cannot restore track because its folder is not in the library");
  }

  await db.transaction("rw", db.tracks, db.playlists, db.trashedTracks, db.ignoredTrackPaths, async () => {
    await db.tracks.put(trashed.track);
    if (!playlist.trackIds.includes(trashed.track.id)) {
      await db.playlists.put({
        ...playlist,
        trackIds: [...playlist.trackIds, trashed.track.id],
        updatedAt: Date.now()
      });
    }
    await db.ignoredTrackPaths.delete(makeIgnoredTrackPathId(trashed.track.sourceId, trashed.track.relativePath));
    await db.trashedTracks.delete(trashId);
  });
};

export const clearTrash = async (): Promise<void> => {
  const [trashedSources, trashedTracks] = await Promise.all([
    db.trashedSources.toArray(),
    db.trashedTracks.toArray()
  ]);
  const trackIdsFromSources = trashedSources.flatMap((entry) => entry.tracks.map((track) => track.id));
  const trackIdsFromTracks = trashedTracks.map((entry) => entry.track.id);
  const trackIds = Array.from(new Set([...trackIdsFromSources, ...trackIdsFromTracks]));

  if (trackIds.length > 0) {
    try {
      await removeArtworkAssociationsForTracks(trackIds);
    } catch (error) {
      // Avoid UI hard-failure when clearing very large trash batches.
      console.warn("Artwork association cleanup failed during clearTrash", error);
    }
  }

  const liveSourceIds = new Set((await db.sources.toArray()).map((source) => source.id));
  const ignoredTrackRecordsToKeep: Track[] = [
    ...trashedSources
      .filter((entry) => liveSourceIds.has(entry.source.id))
      .flatMap((entry) => entry.tracks),
    ...trashedTracks
      .filter((entry) => liveSourceIds.has(entry.track.sourceId))
      .map((entry) => entry.track)
  ];
  const ignoredTrackRecordsToDrop: Track[] = [
    ...trashedSources
      .filter((entry) => !liveSourceIds.has(entry.source.id))
      .flatMap((entry) => entry.tracks),
    ...trashedTracks
      .filter((entry) => !liveSourceIds.has(entry.track.sourceId))
      .map((entry) => entry.track)
  ];
  const ignoredTrackPathRecords = buildIgnoredTrackPathRecords(ignoredTrackRecordsToKeep);
  const ignoredTrackPathIdsToDrop = buildIgnoredTrackPathIds(ignoredTrackRecordsToDrop);

  await db.transaction("rw", [db.sources, db.trashedSources, db.trashedTracks, db.folderHandles, db.trackFileBlobs, db.ignoredTrackPaths], async () => {
    if (ignoredTrackPathRecords.length > 0) {
      await db.ignoredTrackPaths.bulkPut(ignoredTrackPathRecords);
    }
    if (ignoredTrackPathIdsToDrop.length > 0) {
      await db.ignoredTrackPaths.bulkDelete(ignoredTrackPathIdsToDrop);
    }
    await db.trashedSources.clear();
    await db.trashedTracks.clear();
    for (const entry of trashedSources) {
      const sourceStillExists = await db.sources.get(entry.source.id);
      if (!sourceStillExists) {
        await db.folderHandles.delete(entry.source.handleKey);
      }
    }
    for (const chunk of chunkArray(trackIds, DELETE_CHUNK_SIZE)) {
      await db.trackFileBlobs.bulkDelete(chunk);
    }
  });
};

const APP_DATA_CLEAR_TARGETS = new Set<AppDataClearTarget>([
  "favorites",
  "song_images",
  "songs_playlists",
  "trash",
  "metadata_cache"
]);

const normalizeClearAppDataTargets = (targets: AppDataClearTarget[]): AppDataClearTarget[] => {
  const unique: AppDataClearTarget[] = [];
  for (const target of targets) {
    if (!APP_DATA_CLEAR_TARGETS.has(target)) continue;
    if (!unique.includes(target)) {
      unique.push(target);
    }
  }
  return unique;
};

export const clearSelectedAppData = async (targets: AppDataClearTarget[]): Promise<void> => {
  const normalizedTargets = normalizeClearAppDataTargets(targets);
  if (normalizedTargets.length === 0) return;

  const selected = new Set(normalizedTargets);
  const clearSongsAndPlaylists = selected.has("songs_playlists");
  const clearSongImagesOnly = selected.has("song_images") && !clearSongsAndPlaylists;
  const clearFavoritesOnly = selected.has("favorites") && !clearSongsAndPlaylists;
  const clearTrashSelection = selected.has("trash");
  const clearMetadataCache = selected.has("metadata_cache");
  const retainTrashRestoreData = clearSongsAndPlaylists && !clearTrashSelection;
  const now = Date.now();

  if (clearTrashSelection) {
    await clearTrash();
  }

  if (clearFavoritesOnly) {
    await db.tracks.toCollection().modify((track) => {
      if (!track.favorite) return;
      track.favorite = false;
      track.updatedAt = now;
    });
  }

  if (clearSongImagesOnly) {
    await db.transaction(
      "rw",
      [db.tracks, db.trackArtworks, db.entityArtworks, db.artworks, db.artworkFullBlobs, db.artworkCache],
      async () => {
        await db.tracks.toCollection().modify((track) => {
          track.artworkId = undefined;
          track.artworkSource = undefined;
          track.artworkPath = undefined;
          track.artworkOptimizedPath = undefined;
          track.artworkUpdatedAt = now;
          track.artworkUrl = undefined;
          track.artworkCandidateUrl = undefined;
          track.isDefaultArtwork = true;
          track.updatedAt = now;
        });
        await db.trackArtworks.clear();
        await db.entityArtworks.clear();
        await db.artworks.clear();
        await db.artworkFullBlobs.clear();
        await db.artworkCache.clear();
      }
    );
    failedArtworkUrls.clear();
  }

  if (clearSongsAndPlaylists) {
    await db.transaction(
      "rw",
      [
        db.sources,
        db.playlists,
        db.tracks,
        db.folderHandles,
        db.trackFileBlobs,
        db.ignoredTrackPaths,
        db.trackArtworks,
        db.entityArtworks,
        db.artworks,
        db.artworkFullBlobs
      ],
      async () => {
        await db.sources.clear();
        await db.playlists.clear();
        await db.tracks.clear();
        if (!retainTrashRestoreData) {
          await db.folderHandles.clear();
          await db.trackFileBlobs.clear();
          await db.ignoredTrackPaths.clear();
        }
        await db.trackArtworks.clear();
        await db.entityArtworks.clear();
        await db.artworks.clear();
        await db.artworkFullBlobs.clear();
      }
    );
    failedArtworkUrls.clear();
  }

  if (clearMetadataCache) {
    await db.transaction("rw", [db.artworkCache, db.metadataHitCache], async () => {
      await db.artworkCache.clear();
      await db.metadataHitCache.clear();
    });
    failedArtworkUrls.clear();
  }
};

export const reorderSourcePlaylists = async (sourceId: string, orderedPlaylistIds: string[]): Promise<void> => {
  const sourcePlaylists = await db.playlists.where("sourceId").equals(sourceId).toArray();
  if (sourcePlaylists.length <= 1) return;

  const byId = new Map(sourcePlaylists.map((playlist) => [playlist.id, playlist]));
  const ordered: Playlist[] = [];
  for (const id of orderedPlaylistIds) {
    const playlist = byId.get(id);
    if (playlist) {
      ordered.push(playlist);
      byId.delete(id);
    }
  }

  const remainder = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  const finalOrder = [...ordered, ...remainder];
  const now = Date.now();

  await db.transaction("rw", db.playlists, async () => {
    for (let index = 0; index < finalOrder.length; index += 1) {
      const playlist = finalOrder[index];
      await db.playlists.update(playlist.id, {
        order: index,
        updatedAt: now
      });
    }
  });
};

export const toggleFavorite = async (trackId: string): Promise<void> => {
  const track = await db.tracks.get(trackId);
  if (!track) return;
  await db.tracks.update(trackId, { favorite: !track.favorite, updatedAt: Date.now() });
};

export const searchTracks = (tracks: Track[], query: string): Track[] => {
  if (!query.trim()) return tracks;
  const normalized = query.toLowerCase();
  return tracks.filter((track) => {
    return (
      track.name.toLowerCase().includes(normalized) ||
      track.fileName.toLowerCase().includes(normalized) ||
      (track.artist?.toLowerCase().includes(normalized) ?? false) ||
      (track.album?.toLowerCase().includes(normalized) ?? false) ||
      (track.genres?.some((genre) => genre.toLowerCase().includes(normalized)) ?? false)
    );
  });
};

const resolveTrackFileFromBlobStore = async (track: Track): Promise<File | null> => {
  const blobRecord = await db.trackFileBlobs.get(track.id);
  if (!blobRecord?.fileBlob) {
    return null;
  }

  return new File([blobRecord.fileBlob], track.fileName, {
    type: blobRecord.fileBlob.type || "application/octet-stream",
    lastModified: blobRecord.updatedAt
  });
};

export const resolveTrackFile = async (track: Track): Promise<File> => {
  const source = await db.sources.get(track.sourceId);
  if (!source) {
    throw new Error("Track source not found");
  }

  if (source.importType === "files") {
    const stored = await resolveTrackFileFromBlobStore(track);
    if (stored) return stored;
    throw new Error("Track file is unavailable. Re-import this file source.");
  }

  try {
    const { directory, fileName } = await resolveTrackParentDirectory(track.sourceId, track.relativePath, "read");
    const fileHandle = await directory.getFileHandle(fileName);
    return fileHandle.getFile();
  } catch {
    const stored = await resolveTrackFileFromBlobStore(track);
    if (stored) return stored;
    throw new Error("Unable to read this track file");
  }
};

export const ensureTrackDuration = async (trackId: string): Promise<number | null> => {
  const track = await db.tracks.get(trackId);
  if (!track) return null;

  const existingDuration = track.durationSec;
  if (typeof existingDuration === "number" && Number.isFinite(existingDuration) && existingDuration > 0) {
    return existingDuration;
  }

  try {
    const file = await resolveTrackFile(track);
    const parsedMetadata = await parseAudioFileMetadata(file);
    const parsedDuration = parsedMetadata.durationSec;
    if (!(typeof parsedDuration === "number" && Number.isFinite(parsedDuration) && parsedDuration > 0)) {
      return null;
    }

    await db.tracks.update(trackId, {
      durationSec: parsedDuration,
      updatedAt: Date.now()
    });
    return parsedDuration;
  } catch {
    return null;
  }
};

interface ArtworkLookupResult {
  album?: string;
  artworkUrl?: string;
  musicBrainzRecordingId?: string;
  musicBrainzReleaseId?: string;
  genres?: string[];
}

const failedArtworkUrls = new Set<string>();
const LOW_RES_REMOTE_ARTWORK_UPGRADE_ATTEMPTS = new Set<string>();
const REMOTE_ARTWORK_MIN_EDGE_PX = 320;

const normalizeForMatch = (value?: string): string => {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
};

const sanitizeLookupValue = (value?: string): string | undefined => {
  const normalized = value?.replace(/"/g, " ").trim();
  if (!normalized) return undefined;
  return normalized;
};

const sanitizeLookupArtist = (artist?: string): string | undefined => {
  const normalized = sanitizeLookupValue(artist);
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "unknown artist") return undefined;
  return normalized;
};

const normalizeArtworkCandidate = (url?: string): string | undefined => {
  const normalized = url?.trim();
  return normalized ? normalized : undefined;
};

const extractArtworkSizeHint = (url: string): number => {
  const normalized = url.toLowerCase();
  let bestEdge = 0;

  for (const match of normalized.matchAll(/(\d{2,5})x(\d{2,5})/g)) {
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    bestEdge = Math.max(bestEdge, width, height);
  }

  if (normalized.includes("cover_xl")) bestEdge = Math.max(bestEdge, 1000);
  if (normalized.includes("cover_big")) bestEdge = Math.max(bestEdge, 500);
  if (normalized.includes("/large")) bestEdge = Math.max(bestEdge, 900);
  if (normalized.includes("/original")) bestEdge = Math.max(bestEdge, 1400);
  return bestEdge;
};

const scoreArtworkCandidateUrl = (url: string): number => {
  const normalized = url.toLowerCase();
  let score = extractArtworkSizeHint(normalized);

  if (normalized.includes("thumbnail")) score -= 250;
  if (normalized.includes("thumb")) score -= 200;
  if (normalized.includes("small")) score -= 150;
  if (normalized.includes("tiny")) score -= 150;
  if (normalized.includes("cover_small")) score -= 120;
  if (normalized.includes("100x100")) score -= 220;

  return score;
};

const expandArtworkCandidateVariants = (url: string): string[] => {
  const normalized = normalizeArtworkCandidate(url);
  if (!normalized) return [];

  const variants = new Set<string>();
  variants.add(normalized);

  if (/itunes\.apple\.com|mzstatic\.com/i.test(normalized)) {
    variants.add(normalized.replace(/(\d{2,5})x(\d{2,5})(bb|cc|sr|sc)?/i, "1400x1400bb"));
    variants.add(normalized.replace(/(\d{2,5})x(\d{2,5})(bb|cc|sr|sc)?/i, "1200x1200bb"));
    variants.add(normalized.replace(/(\d{2,5})x(\d{2,5})(bb|cc|sr|sc)?/i, "1000x1000bb"));
  }

  if (/deezer\./i.test(normalized)) {
    variants.add(normalized.replace(/cover(?:_small|_medium|_big|_xl)?/i, "cover_xl"));
  }

  const sizeMatch = normalized.match(/(\d{2,5})x(\d{2,5})/i);
  if (sizeMatch) {
    const currentEdge = Math.max(Number.parseInt(sizeMatch[1], 10), Number.parseInt(sizeMatch[2], 10));
    for (const target of [1400, 1200, 1000, 800, 600, 500]) {
      if (!Number.isFinite(currentEdge) || target <= currentEdge) continue;
      variants.add(normalized.replace(/(\d{2,5})x(\d{2,5})/i, `${target}x${target}`));
    }
  }

  return Array.from(variants);
};

const buildPrioritizedArtworkCandidates = (candidates: Array<string | undefined>): string[] => {
  const ranked: Array<{ url: string; score: number; index: number }> = [];
  const seen = new Set<string>();
  let index = 0;

  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const variant of expandArtworkCandidateVariants(candidate)) {
      const normalized = normalizeArtworkCandidate(variant);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ranked.push({
        url: normalized,
        score: scoreArtworkCandidateUrl(normalized),
        index
      });
      index += 1;
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((entry) => entry.url);
};

const pickBestArtworkCandidate = (candidates: Array<string | undefined>): string | undefined => {
  return buildPrioritizedArtworkCandidates(candidates).find((candidate) => !isFailedArtworkUrl(candidate));
};

const getArtworkBlobMaxEdge = async (blob: Blob): Promise<number | null> => {
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      const maxEdge = Math.max(bitmap.width, bitmap.height);
      bitmap.close();
      return maxEdge > 0 ? maxEdge : null;
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Failed to decode artwork image"));
        image.src = objectUrl;
      });
      const maxEdge = Math.max(image.naturalWidth, image.naturalHeight);
      return maxEdge > 0 ? maxEdge : null;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
};

const markArtworkUrlAsFailed = (url?: string): void => {
  const normalized = normalizeArtworkCandidate(url);
  if (!normalized) return;
  failedArtworkUrls.add(normalized);
};

const isFailedArtworkUrl = (url?: string): boolean => {
  const normalized = normalizeArtworkCandidate(url);
  if (!normalized) return false;
  return failedArtworkUrls.has(normalized);
};

const buildArtworkCacheKey = (title?: string, artist?: string): string | null => {
  const titleKey = normalizeForMatch(title);
  if (!titleKey) return null;
  const artistKey = normalizeForMatch(sanitizeLookupArtist(artist));
  return artistKey ? `${titleKey}::${artistKey}` : titleKey;
};

const readArtworkCache = async (track: Track): Promise<ArtworkCacheEntry | null> => {
  const key = buildArtworkCacheKey(track.name, track.artist);
  if (!key) return null;
  return (await db.artworkCache.get(key)) ?? null;
};

const writeArtworkCache = async (track: Track, album?: string, artworkUrl?: string): Promise<void> => {
  const key = buildArtworkCacheKey(track.name, track.artist);
  if (!key) return;

  const cleanedAlbum = album?.trim();
  const cleanedArtwork = artworkUrl?.trim();
  if (!cleanedAlbum && !cleanedArtwork) return;

  await db.artworkCache.put({
    key,
    album: cleanedAlbum,
    artworkUrl: cleanedArtwork,
    updatedAt: Date.now()
  });
};

const applyGlobalArtworkCache = async (tracks: Track[]): Promise<Track[]> => {
  if (tracks.length === 0) return tracks;

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const track of tracks) {
    const key = buildArtworkCacheKey(track.name, track.artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (keys.length === 0) return tracks;

  const entries = await db.artworkCache.bulkGet(keys);
  const byKey = new Map<string, ArtworkCacheEntry>();
  for (let index = 0; index < keys.length; index += 1) {
    const entry = entries[index];
    if (entry) {
      byKey.set(keys[index], entry);
    }
  }

  return tracks.map((track) => {
    const key = buildArtworkCacheKey(track.name, track.artist);
    if (!key) return track;
    const cached = byKey.get(key);
    if (!cached) return track;
    const nextAlbum = cached.album?.trim() || track.album;
    const nextArtworkCandidate = cached.artworkUrl?.trim() || track.artworkCandidateUrl;
    if (nextAlbum === track.album && nextArtworkCandidate === track.artworkCandidateUrl) {
      return track;
    }
    return {
      ...track,
      album: nextAlbum,
      artworkCandidateUrl: nextArtworkCandidate
    };
  });
};

const applyOfflineArtworkDatabase = async (tracks: Track[]): Promise<Track[]> => {
  if (tracks.length === 0) return tracks;

  const enriched = await Promise.all(
    tracks.map(async (track) => {
      if (track.artworkId?.trim() || track.artworkCandidateUrl?.trim()) {
        return track;
      }

      const matched = await resolveArtworkFromLocalDatabase(track);
      if (!matched) return track;

      const nextAlbum = matched.album?.trim() || track.album;
      const nextArtworkCandidate = pickBestArtworkCandidate([matched.artworkUrl, track.artworkCandidateUrl]);
      const nextRecordingId = matched.musicBrainzRecordingId?.trim() || track.musicBrainzRecordingId;
      const nextReleaseId = matched.musicBrainzReleaseId?.trim() || track.musicBrainzReleaseId;

      if (
        nextAlbum === track.album &&
        nextArtworkCandidate === track.artworkCandidateUrl &&
        nextRecordingId === track.musicBrainzRecordingId &&
        nextReleaseId === track.musicBrainzReleaseId
      ) {
        return track;
      }

      return {
        ...track,
        album: nextAlbum,
        artworkCandidateUrl: nextArtworkCandidate,
        musicBrainzRecordingId: nextRecordingId,
        musicBrainzReleaseId: nextReleaseId
      } satisfies Track;
    })
  );

  return enriched;
};

const isAbortError = (error: unknown): boolean => {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name?: string }).name === "AbortError";
  }
  return false;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
};

const normalizeImportString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
};

const resolveFileHandleByRelativePath = async (
  directory: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemFileHandle | null> => {
  const segments = relativePath.split(/[\\/]+/).map((item) => item.trim()).filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) return null;

  let currentDir = directory;
  try {
    for (const segment of segments) {
      currentDir = await currentDir.getDirectoryHandle(segment);
    }
    return await currentDir.getFileHandle(fileName);
  } catch {
    return null;
  }
};

const pickBestMetadataHit = (hits: SongMetadataResultFromInternet[]): SongMetadataResultFromInternet | null => {
  if (hits.length === 0) return null;

  let bestWithArtwork: SongMetadataResultFromInternet | null = null;
  let bestArtworkScore = Number.NEGATIVE_INFINITY;

  for (const hit of hits) {
    const candidate = buildPrioritizedArtworkCandidates(hit.artworkPaths)[0];
    if (!candidate) continue;
    const score = scoreArtworkCandidateUrl(candidate);
    if (!bestWithArtwork || score > bestArtworkScore) {
      bestWithArtwork = hit;
      bestArtworkScore = score;
    }
  }

  if (bestWithArtwork) return bestWithArtwork;
  return hits[0];
};

const persistCandidateArtworkForTrack = async (
  track: Track,
  artworkCandidateUrl?: string,
  signal?: AbortSignal,
  options?: { fallbackCandidates?: string[]; minEdgePx?: number }
): Promise<Track | null> => {
  const candidateUrls = buildPrioritizedArtworkCandidates([
    artworkCandidateUrl,
    ...(options?.fallbackCandidates ?? [])
  ]);
  if (candidateUrls.length === 0) return null;

  for (const candidateUrl of candidateUrls) {
    if (isFailedArtworkUrl(candidateUrl)) continue;

    throwIfAborted(signal);
    const artworkBlob = await fetchArtworkBlobFromUrl(candidateUrl, signal);
    if (!artworkBlob) {
      markArtworkUrlAsFailed(candidateUrl);
      continue;
    }

    if (typeof options?.minEdgePx === "number") {
      const maxEdge = await getArtworkBlobMaxEdge(artworkBlob);
      if (typeof maxEdge === "number" && maxEdge < options.minEdgePx) {
        continue;
      }
    }

    const persisted = await persistTrackArtwork({
      track: {
        ...track,
        artworkCandidateUrl: candidateUrl
      },
      artworkBlob,
      source: "REMOTE"
    });

    await writeArtworkCache(persisted, persisted.album, candidateUrl);
    return persisted;
  }

  return null;
};

const resolveArtworkWithFallbacks = async (track: Track, signal?: AbortSignal): Promise<ArtworkLookupResult | null> => {
  throwIfAborted(signal);

  const localDbMatch = await resolveArtworkFromLocalDatabase(track);
  if (localDbMatch) {
    const candidate = pickBestArtworkCandidate([localDbMatch.artworkUrl, track.artworkCandidateUrl]);

    return {
      album: localDbMatch.album?.trim() || track.album,
      artworkUrl: candidate,
      musicBrainzRecordingId: localDbMatch.musicBrainzRecordingId?.trim() || track.musicBrainzRecordingId,
      musicBrainzReleaseId: localDbMatch.musicBrainzReleaseId?.trim() || track.musicBrainzReleaseId
    };
  }

  const hits = await searchSongMetadataResultsInInternet(track.name, track.artist ? [track.artist] : []);
  const bestHit = pickBestMetadataHit(hits);
  if (!bestHit) return null;

  const candidate = pickBestArtworkCandidate(bestHit.artworkPaths);

  return {
    album: bestHit.album?.trim() || track.album,
    artworkUrl: candidate,
    genres: bestHit.genres && bestHit.genres.length > 0 ? bestHit.genres : track.genres
  };
};

export const ensureTrackMetadata = async (
  trackId: string,
  options?: { signal?: AbortSignal }
): Promise<Track | null> => {
  const signal = options?.signal;
  throwIfAborted(signal);
  const track = await db.tracks.get(trackId);
  if (!track) return null;

  const parsed = splitTitleArtist(track.fileName);
  let workingTrack: Track = {
    ...track,
    name: track.name?.trim() || parsed.title || track.name,
    artist: track.artist?.trim() || parsed.artist || track.artist
  };

  if (workingTrack.name !== track.name || workingTrack.artist !== track.artist) {
    await db.tracks.put(workingTrack);
  }

  if (workingTrack.artworkId) {
    const existingArtworkRecord = await db.artworks.get(workingTrack.artworkId);
    const hydratedWithLocalArtwork = await hydrateTrackWithArtworkUrl(workingTrack);
    if (!hydratedWithLocalArtwork.isDefaultArtwork) {
      const existingMaxEdge = Math.max(existingArtworkRecord?.width ?? 0, existingArtworkRecord?.height ?? 0);
      const shouldAttemptUpgrade =
        Boolean(workingTrack.artworkCandidateUrl) &&
        existingArtworkRecord?.source === "REMOTE" &&
        existingMaxEdge > 0 &&
        existingMaxEdge < REMOTE_ARTWORK_MIN_EDGE_PX &&
        !LOW_RES_REMOTE_ARTWORK_UPGRADE_ATTEMPTS.has(workingTrack.id);

      if (shouldAttemptUpgrade) {
        LOW_RES_REMOTE_ARTWORK_UPGRADE_ATTEMPTS.add(workingTrack.id);
        const upgradedArtwork = await persistCandidateArtworkForTrack(
          workingTrack,
          workingTrack.artworkCandidateUrl,
          signal,
          { minEdgePx: Math.max(REMOTE_ARTWORK_MIN_EDGE_PX, existingMaxEdge + 1) }
        );
        if (upgradedArtwork) {
          return upgradedArtwork;
        }
      }

      return hydratedWithLocalArtwork;
    }

    await removeArtworkAssociationsForTracks([workingTrack.id]);
    workingTrack = {
      ...workingTrack,
      artworkId: undefined,
      artworkSource: undefined,
      artworkPath: undefined,
      artworkOptimizedPath: undefined,
      artworkUpdatedAt: Date.now(),
      isDefaultArtwork: true
    };
    await db.tracks.put(workingTrack);
  }

  try {
    throwIfAborted(signal);

    const cached = await readArtworkCache(workingTrack);
    if (cached) {
      const cachedAlbum = cached.album?.trim() || workingTrack.album;
      const cachedCandidate = pickBestArtworkCandidate([cached.artworkUrl, workingTrack.artworkCandidateUrl]);

      const changedFromCache =
        cachedAlbum !== workingTrack.album ||
        cachedCandidate !== workingTrack.artworkCandidateUrl;

      if (changedFromCache) {
        workingTrack = {
          ...workingTrack,
          album: cachedAlbum,
          artworkCandidateUrl: cachedCandidate,
          updatedAt: Date.now()
        };
        await db.tracks.put(workingTrack);
      }
    }

    const cachedCandidateArtwork = await persistCandidateArtworkForTrack(
      workingTrack,
      workingTrack.artworkCandidateUrl,
      signal
    );
    if (cachedCandidateArtwork) {
      return cachedCandidateArtwork;
    }

    const resolved = await resolveArtworkWithFallbacks(workingTrack, signal);
    if (!resolved) {
      return hydrateTrackWithArtworkUrl(workingTrack);
    }

    const nextAlbum = resolved.album?.trim() || workingTrack.album;
    const nextCandidateArtwork = pickBestArtworkCandidate([resolved.artworkUrl, workingTrack.artworkCandidateUrl]);
    const nextRecordingId =
      resolved.musicBrainzRecordingId?.trim() || workingTrack.musicBrainzRecordingId;
    const nextReleaseId =
      resolved.musicBrainzReleaseId?.trim() || workingTrack.musicBrainzReleaseId;
    const nextGenres =
      resolved.genres && resolved.genres.length > 0 ? resolved.genres : workingTrack.genres;

    const changed =
      nextAlbum !== workingTrack.album ||
      nextCandidateArtwork !== workingTrack.artworkCandidateUrl ||
      nextRecordingId !== workingTrack.musicBrainzRecordingId ||
      nextReleaseId !== workingTrack.musicBrainzReleaseId ||
      JSON.stringify(nextGenres ?? []) !== JSON.stringify(workingTrack.genres ?? []);

    if (changed) {
      workingTrack = {
        ...workingTrack,
        album: nextAlbum,
        artworkCandidateUrl: nextCandidateArtwork,
        musicBrainzRecordingId: nextRecordingId,
        musicBrainzReleaseId: nextReleaseId,
        genres: nextGenres,
        updatedAt: Date.now()
      };
      await db.tracks.put(workingTrack);
      await writeArtworkCache(workingTrack, workingTrack.album, workingTrack.artworkCandidateUrl);
    }

    const resolvedArtwork = await persistCandidateArtworkForTrack(
      workingTrack,
      workingTrack.artworkCandidateUrl,
      signal
    );
    if (resolvedArtwork) {
      return resolvedArtwork;
    }

    return hydrateTrackWithArtworkUrl(workingTrack);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return hydrateTrackWithArtworkUrl(workingTrack);
  }
};

export const updateTrackMetadata = async (
  trackId: string,
  updates: {
    title?: string;
    artist?: string;
    album?: string;
    genres?: string[];
    artworkBlob?: Blob;
    artworkUrl?: string;
    removeArtwork?: boolean;
  }
): Promise<Track | null> => {
  const track = await db.tracks.get(trackId);
  if (!track) return null;

  let workingTrack: Track = {
    ...track,
    name: updates.title?.trim() || track.name,
    artist: updates.artist?.trim() || track.artist,
    album: updates.album?.trim() || track.album,
    genres: updates.genres && updates.genres.length > 0 ? updates.genres : track.genres,
    updatedAt: Date.now()
  };

  await db.tracks.put(workingTrack);

  if (updates.removeArtwork) {
    const removed = await removeTrackArtwork(trackId);
    if (removed) {
      workingTrack = {
        ...removed,
        artworkCandidateUrl: undefined,
        updatedAt: Date.now()
      };
      await db.tracks.put(workingTrack);
    }
  }

  if (updates.artworkBlob) {
    return persistTrackArtwork({
      track: workingTrack,
      artworkBlob: updates.artworkBlob,
      source: "LOCAL"
    });
  }

  const remoteArtworkUrl = normalizeArtworkCandidate(updates.artworkUrl);
  if (remoteArtworkUrl) {
    const fetched = await fetchArtworkBlobFromUrl(remoteArtworkUrl);
    if (fetched) {
      const persisted = await persistTrackArtwork({
        track: {
          ...workingTrack,
          artworkCandidateUrl: remoteArtworkUrl
        },
        artworkBlob: fetched,
        source: "REMOTE"
      });
      await writeArtworkCache(persisted, persisted.album, remoteArtworkUrl);
      return persisted;
    }
  }

  return hydrateTrackWithArtworkUrl(workingTrack);
};

export const reportTrackArtworkFailure = async (trackId: string, artworkUrl?: string): Promise<Track | null> => {
  markArtworkUrlAsFailed(artworkUrl);

  const track = await db.tracks.get(trackId);
  if (!track) return null;
  const cacheKey = buildArtworkCacheKey(track.name, track.artist);

  const removedArtwork = await removeTrackArtwork(trackId);
  const baseTrack = removedArtwork ?? track;
  const nextTrack: Track = {
    ...baseTrack,
    artworkCandidateUrl: undefined,
    updatedAt: Date.now()
  };

  await db.transaction("rw", db.tracks, db.artworkCache, async () => {
    await db.tracks.put(nextTrack);
    if (cacheKey) {
      await db.artworkCache.delete(cacheKey);
    }
  });

  return hydrateTrackWithArtworkUrl(nextTrack);
};
