import Dexie, { type Table } from "dexie";
import type {
  ArtworkCacheEntry,
  ArtworkFullBlobRecord,
  ArtworkRecord,
  EntityArtworkLink,
  FolderHandleRecord,
  IgnoredTrackPath,
  LibrarySource,
  MetadataHitCacheEntry,
  Playlist,
  TrackFileBlobRecord,
  Track,
  TrackArtworkLink,
  TrashedSource,
  TrashedTrack
} from "../types/media";

class MediaDB extends Dexie {
  sources!: Table<LibrarySource, string>;
  playlists!: Table<Playlist, string>;
  tracks!: Table<Track, string>;
  artworkCache!: Table<ArtworkCacheEntry, string>;
  artworks!: Table<ArtworkRecord, string>;
  artworkFullBlobs!: Table<ArtworkFullBlobRecord, string>;
  trackArtworks!: Table<TrackArtworkLink, [string, string]>;
  entityArtworks!: Table<EntityArtworkLink, string>;
  metadataHitCache!: Table<MetadataHitCacheEntry, string>;
  folderHandles!: Table<FolderHandleRecord, string>;
  trackFileBlobs!: Table<TrackFileBlobRecord, string>;
  ignoredTrackPaths!: Table<IgnoredTrackPath, string>;
  trashedSources!: Table<TrashedSource, string>;
  trashedTracks!: Table<TrashedTrack, string>;

  constructor() {
    super("minimalMediaPlayer");
    this.version(1).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, updatedAt",
      folderHandles: "handleKey"
    });
    this.version(2).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, updatedAt",
      folderHandles: "handleKey",
      trashedSources: "id, trashedAt",
      trashedTracks: "id, trashedAt"
    });
    this.version(3).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, updatedAt",
      artworkCache: "key, updatedAt",
      folderHandles: "handleKey",
      trashedSources: "id, trashedAt",
      trashedTracks: "id, trashedAt"
    });
    this.version(4).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, artworkId, artworkSource, updatedAt",
      artworkCache: "key, updatedAt",
      artworks: "id, source, path, optimizedPath, updatedAt",
      trackArtworks: "[trackId+artworkId], trackId, artworkId, updatedAt",
      entityArtworks: "id, [entityType+entityKey], entityType, entityKey, trackId, artworkId, updatedAt",
      metadataHitCache: "id, [source+queryKey], source, queryKey, updatedAt",
      folderHandles: "handleKey",
      trashedSources: "id, trashedAt",
      trashedTracks: "id, trashedAt"
    });
    this.version(5)
      .stores({
        sources: "id, name, updatedAt",
        playlists: "id, sourceId, updatedAt",
        tracks: "id, playlistId, sourceId, favorite, artworkId, artworkSource, updatedAt",
        artworkCache: "key, updatedAt",
        artworks: "id, source, path, optimizedPath, updatedAt",
        artworkFullBlobs: "id, updatedAt",
        trackArtworks: "[trackId+artworkId], trackId, artworkId, updatedAt",
        entityArtworks: "id, [entityType+entityKey], entityType, entityKey, trackId, artworkId, updatedAt",
        metadataHitCache: "id, [source+queryKey], source, queryKey, updatedAt",
        folderHandles: "handleKey",
        trashedSources: "id, trashedAt",
        trashedTracks: "id, trashedAt"
      })
      .upgrade(async (tx) => {
        const artworksTable = tx.table("artworks");
        const fullBlobsTable = tx.table("artworkFullBlobs");
        const artworks = (await artworksTable.toArray()) as Array<Record<string, unknown>>;

        for (const artwork of artworks) {
          const id = typeof artwork.id === "string" ? artwork.id : undefined;
          if (!id) continue;

          const fullBlob = artwork.fullBlob;
          const updatedAt = typeof artwork.updatedAt === "number" ? artwork.updatedAt : Date.now();

          if (fullBlob instanceof Blob) {
            await fullBlobsTable.put({
              id,
              fullBlob,
              updatedAt
            });
            delete artwork.fullBlob;
            await artworksTable.put(artwork);
          }
        }
      });
    this.version(6).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, artworkId, artworkSource, updatedAt",
      artworkCache: "key, updatedAt",
      artworks: "id, source, path, optimizedPath, updatedAt",
      artworkFullBlobs: "id, updatedAt",
      trackArtworks: "[trackId+artworkId], trackId, artworkId, updatedAt",
      entityArtworks: "id, [entityType+entityKey], entityType, entityKey, trackId, artworkId, updatedAt",
      metadataHitCache: "id, [source+queryKey], source, queryKey, updatedAt",
      folderHandles: "handleKey",
      trackFileBlobs: "trackId, updatedAt",
      trashedSources: "id, trashedAt",
      trashedTracks: "id, trashedAt"
    });
    this.version(7).stores({
      sources: "id, name, updatedAt",
      playlists: "id, sourceId, updatedAt",
      tracks: "id, playlistId, sourceId, favorite, artworkId, artworkSource, updatedAt",
      artworkCache: "key, updatedAt",
      artworks: "id, source, path, optimizedPath, updatedAt",
      artworkFullBlobs: "id, updatedAt",
      trackArtworks: "[trackId+artworkId], trackId, artworkId, updatedAt",
      entityArtworks: "id, [entityType+entityKey], entityType, entityKey, trackId, artworkId, updatedAt",
      metadataHitCache: "id, [source+queryKey], source, queryKey, updatedAt",
      folderHandles: "handleKey",
      trackFileBlobs: "trackId, updatedAt",
      ignoredTrackPaths: "id, sourceId, relativePath, updatedAt",
      trashedSources: "id, trashedAt",
      trashedTracks: "id, trashedAt"
    });
  }
}

export const db = new MediaDB();
