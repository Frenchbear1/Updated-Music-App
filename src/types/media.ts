export type PlaylistSourceType = "root" | "child";
export type RepeatMode = "off" | "one" | "two";
export type ArtworkSource = "LOCAL" | "REMOTE";
export type ArtworkEntityType = "album" | "artist" | "genre";
export type MetadataSource = "MUSIXMATCH" | "ITUNES" | "GENIUS" | "DEEZER" | "LAST_FM";
export type AppDataClearTarget = "favorites" | "song_images" | "songs_playlists" | "trash" | "metadata_cache";

export interface LibrarySource {
  id: string;
  name: string;
  handleKey: string;
  importType?: "folder" | "files";
  createdAt: number;
  updatedAt: number;
}

export interface Playlist {
  id: string;
  sourceId: string;
  name: string;
  sourceType: PlaylistSourceType;
  trackIds: string[];
  order?: number;
  updatedAt: number;
}

export interface Track {
  id: string;
  playlistId: string;
  sourceId: string;
  name: string;
  artist?: string;
  album?: string;
  genres?: string[];
  artworkUrl?: string;
  artworkCandidateUrl?: string;
  artworkId?: string;
  artworkSource?: ArtworkSource;
  artworkPath?: string;
  artworkOptimizedPath?: string;
  artworkUpdatedAt?: number;
  isDefaultArtwork?: boolean;
  acoustIdFingerprint?: string;
  musicBrainzRecordingId?: string;
  musicBrainzReleaseId?: string;
  fileName: string;
  pathHint: string;
  relativePath: string;
  durationSec?: number;
  favorite: boolean;
  updatedAt: number;
}

export interface ArtworkCacheEntry {
  key: string;
  album?: string;
  artworkUrl?: string;
  updatedAt: number;
}

export interface ArtworkRecord {
  id: string;
  source: ArtworkSource;
  path: string;
  optimizedPath: string;
  mimeType: string;
  optimizedMimeType: string;
  width: number;
  height: number;
  optimizedWidth: number;
  optimizedHeight: number;
  optimizedBlob: Blob;
  createdAt: number;
  updatedAt: number;
}

export interface ArtworkFullBlobRecord {
  id: string;
  fullBlob: Blob;
  updatedAt: number;
}

export interface TrackArtworkLink {
  trackId: string;
  artworkId: string;
  createdAt: number;
  updatedAt: number;
}

export interface EntityArtworkLink {
  id: string;
  entityType: ArtworkEntityType;
  entityKey: string;
  trackId: string;
  artworkId: string;
  createdAt: number;
  updatedAt: number;
}

export interface SongMetadataResultFromInternet {
  title: string;
  artists: string[];
  album?: string;
  artworkPaths: string[];
  genres?: string[];
  duration?: number;
  releasedYear?: number;
  language?: string;
  lyrics?: string;
  source: MetadataSource;
  sourceId: string;
}

export interface MetadataHitCacheEntry {
  id: string;
  source: MetadataSource;
  queryKey: string;
  selectedSourceId: string;
  payload: SongMetadataResultFromInternet;
  updatedAt: number;
}

export interface FolderHandleRecord {
  handleKey: string;
  handle: FileSystemDirectoryHandle;
}

export interface TrackFileBlobRecord {
  trackId: string;
  fileBlob: Blob;
  updatedAt: number;
}

export interface IgnoredTrackPath {
  id: string;
  sourceId: string;
  relativePath: string;
  updatedAt: number;
}

export interface TrashedSource {
  id: string;
  source: LibrarySource;
  playlists: Playlist[];
  tracks: Track[];
  trashedAt: number;
}

export interface TrashedTrack {
  id: string;
  track: Track;
  sourceName: string;
  playlistName: string;
  trashedAt: number;
}

export interface PlayerState {
  currentTrackId: string | null;
  queue: string[];
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  seekSec: number;
}

export interface ImportResult {
  source: LibrarySource;
  playlists: Playlist[];
  tracks: Track[];
}

export interface RefreshResult {
  source: LibrarySource;
  playlists: Playlist[];
  tracks: Track[];
}
