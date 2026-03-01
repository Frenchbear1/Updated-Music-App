import { db } from "./db";
import { resolveArtworkFromLocalDatabase } from "./offlineMusicDb";
import { fetchArtworkBlobFromUrl, hydrateTrackWithArtworkUrl, hydrateTracksWithArtworkUrls, persistTrackArtwork, removeArtworkAssociationsForTracks, removeTrackArtwork } from "./artworks";
import { parseAudioFileMetadata } from "./embeddedMetadata";
import { searchSongMetadataResultsInInternet } from "./internetMetadata";
import type {
  ArtworkCacheEntry,
  ImportResult,
  LibrarySource,
  Playlist,
  RefreshResult,
  SongMetadataResultFromInternet,
  Track,
  TrashedSource,
  TrashedTrack
} from "../types/media";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);

interface ScannedFile {
  name: string;
  artist: string;
  fileName: string;
  relativePath: string;
  pathHint: string;
}

interface ExportedPlaylistTrack {
  title?: string;
  artist?: string;
  album?: string;
  artworkFile?: string;
  artworkUrl?: string;
}

interface ExportedPlaylistPayload {
  tracks?: ExportedPlaylistTrack[];
}

interface ExportedPlaylistJsonFile {
  directory: FileSystemDirectoryHandle;
  fileName: string;
}

interface PendingArtworkCacheEntry {
  album?: string;
  artworkUrl?: string;
}

interface ImportedCoverCandidate {
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  normalizedTitle: string;
  canonicalTitle: string;
}

export interface CoverDatabaseImportResult {
  playlistFiles: number;
  cacheEntries: number;
  tracksUpdated: number;
  coversResolved: number;
  coversMissing: number;
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

const joinPath = (segments: string[]): string => segments.join("/");

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
      genres: previous?.genres
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
        genres: parsedMetadata.genres && parsedMetadata.genres.length > 0 ? parsedMetadata.genres : nextTrack.genres
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

export const refreshSource = async (sourceId: string): Promise<RefreshResult> => {
  const source = await db.sources.get(sourceId);
  if (!source) {
    throw new Error("Source not found");
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
  const { playlists, tracks: scannedTracks } = await buildLibraryFromHandle(source.id, source.name, handleRecord.handle, favoriteByPath);
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
          musicBrainzReleaseId: previous.musicBrainzReleaseId ?? track.musicBrainzReleaseId
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

const clearFolderContents = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const targets: string[] = [];
  for await (const [name] of handle.entries()) {
    targets.push(name);
  }
  for (const name of targets) {
    await handle.removeEntry(name, { recursive: true });
  }
};

export const removeSource = async (sourceId: string, mode: "unlink" | "delete"): Promise<void> => {
  const source = await db.sources.get(sourceId);
  if (!source) return;
  const sourceTracks = await db.tracks.where("sourceId").equals(sourceId).toArray();

  if (mode === "delete") {
    const handleRecord = await db.folderHandles.get(source.handleKey);
    if (!handleRecord) {
      throw new Error("Cannot delete local folder because handle is unavailable");
    }

    const permission = await handleRecord.handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      const result = await handleRecord.handle.requestPermission({ mode: "readwrite" });
      if (result !== "granted") {
        throw new Error("Folder delete permission denied");
      }
    }

    await clearFolderContents(handleRecord.handle);
  }

  if (sourceTracks.length > 0) {
    await removeArtworkAssociationsForTracks(sourceTracks.map((track) => track.id));
  }

  await db.transaction("rw", db.sources, db.playlists, db.tracks, db.folderHandles, async () => {
    await db.playlists.where("sourceId").equals(sourceId).delete();
    await db.tracks.where("sourceId").equals(sourceId).delete();
    await db.sources.delete(sourceId);
    await db.folderHandles.delete(source.handleKey);
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

export const restoreTrashedSource = async (trashId: string): Promise<void> => {
  const trashed = await db.trashedSources.get(trashId);
  if (!trashed) return;

  const exists = await db.sources.get(trashed.source.id);
  if (exists) {
    throw new Error("Cannot restore folder because it already exists in your library");
  }

  await db.transaction("rw", db.sources, db.playlists, db.tracks, db.trashedSources, async () => {
    await db.sources.put(trashed.source);
    if (trashed.playlists.length > 0) {
      await db.playlists.bulkPut(trashed.playlists);
    }
    if (trashed.tracks.length > 0) {
      await db.tracks.bulkPut(trashed.tracks);
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

  if (mode === "delete") {
    const { directory, fileName } = await resolveTrackParentDirectory(track.sourceId, track.relativePath, "readwrite");
    await directory.removeEntry(fileName);
    await removeArtworkAssociationsForTracks([trackId]);
  }

  await db.transaction("rw", db.tracks, db.playlists, async () => {
    await db.tracks.delete(trackId);
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

  await db.transaction("rw", db.tracks, db.playlists, db.trashedTracks, async () => {
    await db.trashedTracks.put(trashedTrack);
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

  await db.transaction("rw", db.tracks, db.playlists, db.trashedTracks, async () => {
    await db.tracks.put(trashed.track);
    if (!playlist.trackIds.includes(trashed.track.id)) {
      await db.playlists.put({
        ...playlist,
        trackIds: [...playlist.trackIds, trashed.track.id],
        updatedAt: Date.now()
      });
    }
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
    await removeArtworkAssociationsForTracks(trackIds);
  }

  await db.transaction("rw", db.trashedSources, db.trashedTracks, db.folderHandles, async () => {
    await db.trashedSources.clear();
    await db.trashedTracks.clear();
    for (const entry of trashedSources) {
      await db.folderHandles.delete(entry.source.handleKey);
    }
  });
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

export const resolveTrackFile = async (track: Track): Promise<File> => {
  const { directory, fileName } = await resolveTrackParentDirectory(track.sourceId, track.relativePath, "read");
  const fileHandle = await directory.getFileHandle(fileName);
  return fileHandle.getFile();
};

interface ArtworkLookupResult {
  album?: string;
  artworkUrl?: string;
  musicBrainzRecordingId?: string;
  musicBrainzReleaseId?: string;
  genres?: string[];
}

const failedArtworkUrls = new Set<string>();

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
      const nextArtworkCandidate = matched.artworkUrl?.trim() || track.artworkCandidateUrl;
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

const blobToDataUrl = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read artwork data"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read artwork data"));
    reader.readAsDataURL(blob);
  });
};

const normalizeImportString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const stripTrailingArtistFromTitle = (title?: string, artist?: string): string | undefined => {
  const cleanedTitle = normalizeImportString(title);
  if (!cleanedTitle) return undefined;
  const cleanedArtist = normalizeImportString(artist);
  if (!cleanedArtist) return cleanedTitle;

  const withoutArtist = cleanedTitle.replace(
    new RegExp(`\\s*[-–—:|,]*\\s*${escapeRegExp(cleanedArtist)}\\s*$`, "i"),
    ""
  );
  const normalizedWithoutArtist = normalizeImportString(withoutArtist);
  return normalizedWithoutArtist || cleanedTitle;
};

const stripTitleQualifiers = (title?: string): string | undefined => {
  const cleanedTitle = normalizeImportString(title);
  if (!cleanedTitle) return undefined;

  const qualifierPattern =
    /(feat|featuring|ft|live|radio|studio|version|edit|acoustic|mix|remaster|performance|background vocals|collab|alternate)/i;

  let next = cleanedTitle
    .replace(/[_/]+/g, " ")
    .replace(/\(([^)]*)\)/g, (full, content: string) => (qualifierPattern.test(content) ? "" : full))
    .replace(/\[([^\]]*)\]/g, (full, content: string) => (qualifierPattern.test(content) ? "" : full))
    .replace(/\b(feat\.?|featuring|ft\.?)\b.*$/i, "")
    .replace(
      /\b(live|radio version|radio edit|studio version|acoustic|collab version|alternate version|performance track|no background vocals)\b/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  const normalized = normalizeImportString(next);
  return normalized || cleanedTitle;
};

const tokenOverlapRatio = (left: string, right: string): number => {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }
  const denominator = Math.min(leftTokens.size, rightTokens.size);
  return denominator > 0 ? shared / denominator : 0;
};

const buildImportTitleVariants = (title?: string, artist?: string): string[] => {
  const variants = new Set<string>();
  const cleanedTitle = normalizeImportString(title);
  if (!cleanedTitle) return [];
  variants.add(cleanedTitle);

  const withoutArtist = stripTrailingArtistFromTitle(cleanedTitle, artist);
  if (withoutArtist) {
    variants.add(withoutArtist);
  }

  const withoutQualifiers = stripTitleQualifiers(withoutArtist ?? cleanedTitle);
  if (withoutQualifiers) {
    variants.add(withoutQualifiers);
  }

  return Array.from(variants);
};

const upsertArtworkCacheByKey = (
  byKey: Map<string, PendingArtworkCacheEntry>,
  key: string,
  album?: string,
  artworkUrl?: string
): void => {
  const normalizedAlbum = normalizeImportString(album);
  const normalizedArtwork = normalizeImportString(artworkUrl);
  if (!normalizedAlbum && !normalizedArtwork) return;

  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, {
      album: normalizedAlbum,
      artworkUrl: normalizedArtwork
    });
    return;
  }

  if (!existing.album?.trim() && normalizedAlbum) {
    existing.album = normalizedAlbum;
  }
  if (!existing.artworkUrl?.trim() && normalizedArtwork) {
    existing.artworkUrl = normalizedArtwork;
  }
};

const scoreImportedCandidateForTrack = (track: Track, candidate: ImportedCoverCandidate): number => {
  const trackTitle = normalizeForMatch(track.name);
  const trackCanonical = normalizeForMatch(stripTitleQualifiers(track.name) ?? track.name);
  if (!trackTitle && !trackCanonical) return -1;

  let score = 0;
  if (trackTitle && candidate.normalizedTitle) {
    if (trackTitle === candidate.normalizedTitle) {
      score += 8;
    } else if (trackTitle.includes(candidate.normalizedTitle) || candidate.normalizedTitle.includes(trackTitle)) {
      score += 5;
    }
  }

  if (trackCanonical && candidate.canonicalTitle) {
    if (trackCanonical === candidate.canonicalTitle) {
      score += 7;
    } else if (trackCanonical.includes(candidate.canonicalTitle) || candidate.canonicalTitle.includes(trackCanonical)) {
      score += 4;
    } else if (tokenOverlapRatio(trackCanonical, candidate.canonicalTitle) >= 0.75) {
      score += 2;
    }
  }

  if (candidate.artworkUrl?.startsWith("data:")) {
    score += 1;
  }
  return score;
};

const findBestImportedCandidateForTrack = (
  track: Track,
  candidates: ImportedCoverCandidate[]
): ImportedCoverCandidate | null => {
  let bestCandidate: ImportedCoverCandidate | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreImportedCandidateForTrack(track, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestScore >= 7 ? bestCandidate : null;
};

const asExportedPlaylistPayload = (value: unknown): ExportedPlaylistPayload | null => {
  if (!value || typeof value !== "object") return null;
  return value as ExportedPlaylistPayload;
};

const scanForPlaylistJsonFiles = async (
  directory: FileSystemDirectoryHandle
): Promise<ExportedPlaylistJsonFile[]> => {
  const files: ExportedPlaylistJsonFile[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".json")) {
      files.push({
        directory,
        fileName: name
      });
      continue;
    }

    if (handle.kind === "directory") {
      const nested = await scanForPlaylistJsonFiles(handle as FileSystemDirectoryHandle);
      files.push(...nested);
    }
  }
  return files;
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

const resolveArtworkFileFromExport = async (
  jsonDirectory: FileSystemDirectoryHandle,
  artworkFileName: string
): Promise<File | null> => {
  const cleanedArtworkFile = artworkFileName.trim();
  if (!cleanedArtworkFile) return null;

  const candidates = new Set<string>([cleanedArtworkFile]);
  if (!cleanedArtworkFile.includes("/") && !cleanedArtworkFile.includes("\\")) {
    candidates.add(`covers/${cleanedArtworkFile}`);
  }

  for (const candidate of candidates) {
    const handle = await resolveFileHandleByRelativePath(jsonDirectory, candidate);
    if (!handle) continue;
    try {
      return await handle.getFile();
    } catch {
      // Continue trying candidate paths.
    }
  }

  return null;
};

const isLikelyImageFile = (file: File, fileName: string): boolean => {
  const mime = file.type?.toLowerCase().trim();
  if (mime.startsWith("image/")) {
    return true;
  }

  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return false;
  return new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif"]).has(ext);
};

export const importCoverExportsFolder = async (): Promise<CoverDatabaseImportResult> => {
  const rootHandle = await window.showDirectoryPicker({ mode: "read" });
  const jsonFiles = await scanForPlaylistJsonFiles(rootHandle);
  if (jsonFiles.length === 0) {
    throw new Error("No playlist JSON files were found in this folder");
  }

  const byKey = new Map<string, PendingArtworkCacheEntry>();
  const importedCandidates: ImportedCoverCandidate[] = [];
  const artworkFileCache = new Map<string, string | null>();
  let playlistFiles = 0;
  let coversResolved = 0;
  let coversMissing = 0;

  for (const jsonFile of jsonFiles) {
    let payload: ExportedPlaylistPayload | null = null;

    try {
      const handle = await jsonFile.directory.getFileHandle(jsonFile.fileName);
      const file = await handle.getFile();
      payload = asExportedPlaylistPayload(JSON.parse(await file.text()));
    } catch {
      continue;
    }

    if (!payload?.tracks || !Array.isArray(payload.tracks)) {
      continue;
    }

    playlistFiles += 1;
    for (const track of payload.tracks) {
      const rawTitle = normalizeImportString(track?.title);
      if (!rawTitle) continue;
      const artist = normalizeImportString(track?.artist);
      const album = normalizeImportString(track?.album);
      const titleForMatch = stripTrailingArtistFromTitle(rawTitle, artist) ?? rawTitle;
      const titleVariants = buildImportTitleVariants(rawTitle, artist);

      const artworkFile = normalizeImportString(track?.artworkFile);
      const artworkUrl = normalizeImportString(track?.artworkUrl);

      let resolvedArtworkUrl: string | undefined;
      if (artworkFile) {
        const cacheKey = `${jsonFile.fileName}::${artworkFile}`;
        if (artworkFileCache.has(cacheKey)) {
          const cached = artworkFileCache.get(cacheKey);
          if (cached) {
            resolvedArtworkUrl = cached;
          }
        } else {
          const coverFile = await resolveArtworkFileFromExport(jsonFile.directory, artworkFile);
          if (coverFile) {
            if (isLikelyImageFile(coverFile, artworkFile)) {
              const dataUrl = await blobToDataUrl(coverFile);
              artworkFileCache.set(cacheKey, dataUrl);
              resolvedArtworkUrl = dataUrl;
              coversResolved += 1;
            } else {
              artworkFileCache.set(cacheKey, null);
              coversMissing += 1;
            }
          } else {
            artworkFileCache.set(cacheKey, null);
            coversMissing += 1;
          }
        }
      }

      if (!resolvedArtworkUrl && artworkUrl) {
        resolvedArtworkUrl = artworkUrl;
      }

      if (!album && !resolvedArtworkUrl) {
        continue;
      }

      for (const titleVariant of titleVariants) {
        const key = buildArtworkCacheKey(titleVariant, artist);
        if (!key) continue;
        upsertArtworkCacheByKey(byKey, key, album, resolvedArtworkUrl);
      }

      importedCandidates.push({
        title: titleForMatch,
        artist,
        album,
        artworkUrl: resolvedArtworkUrl,
        normalizedTitle: normalizeForMatch(titleForMatch),
        canonicalTitle: normalizeForMatch(stripTitleQualifiers(titleForMatch) ?? titleForMatch)
      });
    }
  }

  if (playlistFiles === 0) {
    throw new Error("No valid playlist export JSON was found");
  }

  const existingTracks = await db.tracks.toArray();
  for (const track of existingTracks) {
    const localKey = buildArtworkCacheKey(track.name, track.artist);
    if (!localKey || byKey.has(localKey)) continue;
    const matched = findBestImportedCandidateForTrack(track, importedCandidates);
    if (!matched) continue;
    upsertArtworkCacheByKey(byKey, localKey, matched.album, matched.artworkUrl);
  }

  const now = Date.now();
  const entries: ArtworkCacheEntry[] = Array.from(byKey.entries())
    .map(([key, value]) => ({
      key,
      album: value.album?.trim() || undefined,
      artworkUrl: value.artworkUrl?.trim() || undefined,
      updatedAt: now
    }))
    .filter((entry) => Boolean(entry.album || entry.artworkUrl));

  if (entries.length === 0) {
    throw new Error("No usable cover mappings were found in the selected folder");
  }

  await db.artworkCache.bulkPut(entries);

  const withCacheApplied = await applyGlobalArtworkCache(existingTracks);
  const updatedTracks: Track[] = [];

  for (let index = 0; index < withCacheApplied.length; index += 1) {
    const currentTrack = existingTracks[index];
    const nextTrack = withCacheApplied[index];
    const changed =
      currentTrack.album !== nextTrack.album ||
      currentTrack.artworkCandidateUrl !== nextTrack.artworkCandidateUrl;
    if (!changed) continue;
    updatedTracks.push({
      ...nextTrack,
      updatedAt: now
    });
  }

  if (updatedTracks.length > 0) {
    await db.tracks.bulkPut(updatedTracks);
  }

  return {
    playlistFiles,
    cacheEntries: entries.length,
    tracksUpdated: updatedTracks.length,
    coversResolved,
    coversMissing
  };
};

const pickBestMetadataHit = (hits: SongMetadataResultFromInternet[]): SongMetadataResultFromInternet | null => {
  if (hits.length === 0) return null;
  const withArtwork = hits.find((hit) =>
    hit.artworkPaths.some((path) => Boolean(normalizeArtworkCandidate(path)))
  );
  if (withArtwork) return withArtwork;
  return hits[0];
};

const persistCandidateArtworkForTrack = async (
  track: Track,
  artworkCandidateUrl?: string,
  signal?: AbortSignal
): Promise<Track | null> => {
  const candidateUrl = normalizeArtworkCandidate(artworkCandidateUrl);
  if (!candidateUrl) return null;
  if (isFailedArtworkUrl(candidateUrl)) return null;

  throwIfAborted(signal);
  const artworkBlob = await fetchArtworkBlobFromUrl(candidateUrl, signal);
  if (!artworkBlob) {
    markArtworkUrlAsFailed(candidateUrl);
    return null;
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
};

const resolveArtworkWithFallbacks = async (track: Track, signal?: AbortSignal): Promise<ArtworkLookupResult | null> => {
  throwIfAborted(signal);

  const localDbMatch = await resolveArtworkFromLocalDatabase(track);
  if (localDbMatch) {
    const candidate = normalizeArtworkCandidate(localDbMatch.artworkUrl);
    if (candidate && isFailedArtworkUrl(candidate)) {
      return {
        album: localDbMatch.album?.trim() || track.album,
        musicBrainzRecordingId: localDbMatch.musicBrainzRecordingId?.trim() || track.musicBrainzRecordingId,
        musicBrainzReleaseId: localDbMatch.musicBrainzReleaseId?.trim() || track.musicBrainzReleaseId
      };
    }

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

  const candidate = bestHit.artworkPaths
    .map((path) => normalizeArtworkCandidate(path))
    .find((path): path is string => Boolean(path) && !isFailedArtworkUrl(path));

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
    const hydratedWithLocalArtwork = await hydrateTrackWithArtworkUrl(workingTrack);
    if (!hydratedWithLocalArtwork.isDefaultArtwork) {
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
      const cachedCandidate =
        normalizeArtworkCandidate(cached.artworkUrl) ||
        normalizeArtworkCandidate(workingTrack.artworkCandidateUrl);

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
    const nextCandidateArtwork =
      normalizeArtworkCandidate(resolved.artworkUrl) ||
      normalizeArtworkCandidate(workingTrack.artworkCandidateUrl);
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
