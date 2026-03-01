import { db } from "./db";
import type { MetadataHitCacheEntry, MetadataSource, SongMetadataResultFromInternet } from "../types/media";

const MUSIXMATCH_BASE_URL = "https://apic-desktop.musixmatch.com";
const ITUNES_BASE_URL = "https://itunes.apple.com";
const GENIUS_BASE_URL = "https://api.genius.com";
const DEEZER_BASE_URL = "https://api.deezer.com";
const LAST_FM_BASE_URL = "https://ws.audioscrobbler.com/2.0/";
const SPOTIFY_OEMBED_BASE_URL = "https://open.spotify.com/oembed?url=https://open.spotify.com/track/";

const spotifyImageIdRegex = /(?<=1e02|b273)(\w{24})/gm;
const spotifyReqVarIdRegex = /(?<=\/image\/)(\w{12})(?=1e02|b273)/gm;

const inMemorySourceCache = new Map<string, SongMetadataResultFromInternet>();
const iTunesHitsCache = new Map<string, SongMetadataResultFromInternet>();
const deezerHitsCache = new Map<string, SongMetadataResultFromInternet>();
const geniusHitsCache = new Map<string, SongMetadataResultFromInternet>();

const cleanText = (value?: string): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned : undefined;
};

const normalizeQueryValue = (value?: string): string => {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
};

export const buildMetadataQueryKey = (title: string, artists: string[] = []): string => {
  const titleKey = normalizeQueryValue(title);
  const artistKey = normalizeQueryValue(artists.join(" "));
  return [titleKey, artistKey].filter(Boolean).join("::");
};

const putSelectedSourceHit = async (
  source: MetadataSource,
  queryKey: string,
  hit: SongMetadataResultFromInternet
): Promise<void> => {
  const entry: MetadataHitCacheEntry = {
    id: `${source}:${queryKey}`,
    source,
    queryKey,
    selectedSourceId: hit.sourceId,
    payload: hit,
    updatedAt: Date.now()
  };
  await db.metadataHitCache.put(entry);
};

const readCachedHitsForQuery = async (queryKey: string): Promise<SongMetadataResultFromInternet[]> => {
  const entries = await db.metadataHitCache.where("queryKey").equals(queryKey).toArray();
  return entries.map((entry) => entry.payload);
};

const cacheBySourceId = (hit: SongMetadataResultFromInternet): void => {
  inMemorySourceCache.set(`${hit.source}:${hit.sourceId}`, hit);
  if (hit.source === "ITUNES") iTunesHitsCache.set(hit.sourceId, hit);
  if (hit.source === "DEEZER") deezerHitsCache.set(hit.sourceId, hit);
  if (hit.source === "GENIUS") geniusHitsCache.set(hit.sourceId, hit);
};

const fetchSongArtworksFromSpotify = async (
  spotifySongId: string
): Promise<{ highResArtworkUrl: string; lowResArtworkUrl: string } | undefined> => {
  const id = cleanText(spotifySongId);
  if (!id) return undefined;

  try {
    const response = await fetch(`${SPOTIFY_OEMBED_BASE_URL}${id}`);
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { thumbnail_url?: string };
    const thumbnailUrl = cleanText(payload.thumbnail_url);
    if (!thumbnailUrl) return undefined;

    const spotifyImgIds = thumbnailUrl.match(spotifyImageIdRegex);
    const spotifyReqIds = thumbnailUrl.match(spotifyReqVarIdRegex);
    if (!spotifyImgIds?.[0] || !spotifyReqIds?.[0]) return undefined;

    return {
      lowResArtworkUrl: thumbnailUrl,
      highResArtworkUrl: `https://i.scdn.co/image/${spotifyReqIds[0]}b273${spotifyImgIds[0]}`
    };
  } catch {
    return undefined;
  }
};

const parseMusixmatchMetadata = async (payload: unknown): Promise<SongMetadataResultFromInternet[]> => {
  const track = (payload as { message?: { body?: { macro_calls?: Record<string, { message?: { body?: { track?: Record<string, unknown> } } }> } } })
    ?.message?.body?.macro_calls?.["matcher.track.get"]?.message?.body?.track;
  if (!track) return [];

  const title = cleanText(track.track_name as string);
  const artist = cleanText(track.artist_name as string);
  if (!title || !artist) return [];

  const artworkPaths = new Set<string>();
  const coverCandidates = [
    cleanText(track.album_coverart_100x100 as string),
    cleanText(track.album_coverart_350x350 as string),
    cleanText(track.album_coverart_500x500 as string),
    cleanText(track.album_coverart_800x800 as string)
  ];
  for (const candidate of coverCandidates) {
    if (candidate) artworkPaths.add(candidate);
  }

  const spotifyTrackId = cleanText(track.track_spotify_id as string);
  if (spotifyTrackId) {
    const spotifyArtworks = await fetchSongArtworksFromSpotify(spotifyTrackId);
    if (spotifyArtworks) {
      artworkPaths.add(spotifyArtworks.lowResArtworkUrl);
      artworkPaths.add(spotifyArtworks.highResArtworkUrl);
    }
  }

  const sourceId =
    cleanText((track.track_id as number | string | undefined)?.toString()) ??
    `${title}:${artist}`;

  return [
    {
      title,
      artists: [artist],
      album: cleanText(track.album_name as string),
      artworkPaths: Array.from(artworkPaths),
      duration: typeof track.track_length === "number" ? track.track_length : undefined,
      language: cleanText(track.lyrics_language as string),
      source: "MUSIXMATCH",
      sourceId
    }
  ];
};

const searchMusixmatch = async (
  songTitle: string,
  songArtists?: string
): Promise<SongMetadataResultFromInternet[]> => {
  const token = cleanText(
    (import.meta.env.VITE_MUSIXMATCH_DEFAULT_USER_TOKEN as string | undefined) ??
      (import.meta.env.MAIN_VITE_MUSIXMATCH_DEFAULT_USER_TOKEN as string | undefined)
  );
  if (!token) return [];

  const url = new URL("/ws/1.1/macro.subtitles.get", MUSIXMATCH_BASE_URL);
  url.searchParams.set("namespace", "lyrics_richsynched");
  url.searchParams.set("app_id", "web-desktop-app-v1.0");
  url.searchParams.set("subtitle_format", "mxm");
  url.searchParams.set("format", "json");
  url.searchParams.set("usertoken", token);
  url.searchParams.set("q_track", songTitle);
  if (songArtists) url.searchParams.set("q_artist", songArtists);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        authority: "apic-desktop.musixmatch.com",
        cookie: "x-mxm-token-guid="
      }
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return parseMusixmatchMetadata(payload);
  } catch {
    return [];
  }
};

const searchItunes = async (
  songTitle: string,
  songArtists?: string
): Promise<SongMetadataResultFromInternet[]> => {
  const url = new URL("/search", ITUNES_BASE_URL);
  url.searchParams.set("media", "music");
  url.searchParams.set("term", `${songTitle} ${songArtists ?? ""}`.trim());

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const payload = (await response.json()) as { resultCount?: number; results?: Array<Record<string, unknown>> };
    if (!payload.resultCount || !Array.isArray(payload.results) || payload.results.length === 0) return [];

    const results: SongMetadataResultFromInternet[] = [];
    for (const row of payload.results) {
      const sourceId = cleanText((row.trackId as number | string | undefined)?.toString());
      const title = cleanText(row.trackName as string);
      const artist = cleanText(row.artistName as string);
      if (!sourceId || !title || !artist) continue;

      const cover100 = cleanText(row.artworkUrl100 as string);
      const highResCover = cover100?.replace(/\d+x\d+\w*/, "1000x1000bb");
      const artworkPaths = [cover100, highResCover].filter((candidate): candidate is string => Boolean(candidate));

      const hit: SongMetadataResultFromInternet = {
        title,
        artists: [artist],
        album: cleanText(row.collectionName as string),
        artworkPaths,
        genres: cleanText(row.primaryGenreName as string) ? [cleanText(row.primaryGenreName as string) as string] : undefined,
        duration: typeof row.trackTimeMillis === "number" ? row.trackTimeMillis / 1000 : undefined,
        releasedYear:
          typeof row.releaseDate === "string" ? new Date(row.releaseDate).getFullYear() : undefined,
        source: "ITUNES",
        sourceId
      };

      results.push(hit);
      iTunesHitsCache.set(hit.sourceId, hit);
    }
    return results;
  } catch {
    return [];
  }
};

const searchGenius = async (
  songTitle: string,
  songArtists?: string
): Promise<SongMetadataResultFromInternet[]> => {
  const token = cleanText(
    (import.meta.env.VITE_GENIUS_API_KEY as string | undefined) ??
      (import.meta.env.MAIN_VITE_GENIUS_API_KEY as string | undefined)
  );
  if (!token) return [];

  const url = new URL("/search", GENIUS_BASE_URL);
  url.searchParams.set("q", `${songTitle}${songArtists ? ` ${songArtists}` : ""}`.trim());

  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      response?: {
        hits?: Array<{
          type?: string;
          result?: Record<string, unknown>;
        }>;
      };
    };
    const hits = payload.response?.hits ?? [];
    const results: SongMetadataResultFromInternet[] = [];
    for (const row of hits) {
      if (row.type !== "song") continue;
      const result = row.result ?? {};
      const sourceId = cleanText((result.id as number | string | undefined)?.toString());
      const title = cleanText(result.title as string);
      const primaryArtist = cleanText((result.primary_artist as { name?: string } | undefined)?.name);
      if (!sourceId || !title || !primaryArtist) continue;

      const featured =
        ((result.featured_artists as Array<{ name?: string }> | undefined) ?? [])
          .map((item) => cleanText(item.name))
          .filter((name): name is string => Boolean(name));

      const artworkPaths = [
        cleanText(result.header_image_url as string),
        cleanText(result.song_art_image_url as string)
      ].filter((candidate): candidate is string => Boolean(candidate));

      const hit: SongMetadataResultFromInternet = {
        title,
        artists: [primaryArtist, ...featured],
        album: cleanText((result.album as { name?: string } | undefined)?.name),
        artworkPaths,
        source: "GENIUS",
        sourceId
      };
      results.push(hit);
      geniusHitsCache.set(hit.sourceId, hit);
    }
    return results;
  } catch {
    return [];
  }
};

const searchDeezer = async (
  songTitle: string,
  songArtists?: string
): Promise<SongMetadataResultFromInternet[]> => {
  const query = `track:"${songTitle}"${songArtists ? ` artist:"${songArtists}"` : ""}`;
  const url = new URL("/search", DEEZER_BASE_URL);
  url.searchParams.set("q", query);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
    const hits = payload.data ?? [];
    const results: SongMetadataResultFromInternet[] = [];

    for (const row of hits) {
      const sourceId = cleanText((row.id as number | string | undefined)?.toString());
      const title = cleanText(row.title as string);
      if (!sourceId || !title) continue;

      const artist = cleanText((row.artist as { name?: string } | undefined)?.name);
      const albumTitle = cleanText((row.album as { title?: string } | undefined)?.title);
      const albumCovers = [
        cleanText((row.album as { cover?: string } | undefined)?.cover),
        cleanText((row.album as { cover_small?: string } | undefined)?.cover_small),
        cleanText((row.album as { cover_medium?: string } | undefined)?.cover_medium),
        cleanText((row.album as { cover_big?: string } | undefined)?.cover_big),
        cleanText((row.album as { cover_xl?: string } | undefined)?.cover_xl)
      ].filter((candidate): candidate is string => Boolean(candidate));

      const hit: SongMetadataResultFromInternet = {
        title,
        artists: artist ? [artist] : [],
        album: albumTitle,
        artworkPaths: albumCovers,
        duration: typeof row.duration === "number" ? row.duration : undefined,
        source: "DEEZER",
        sourceId
      };

      results.push(hit);
      deezerHitsCache.set(hit.sourceId, hit);
    }
    return results;
  } catch {
    return [];
  }
};

const searchLastFm = async (
  songTitle: string,
  songArtists?: string
): Promise<SongMetadataResultFromInternet[]> => {
  const apiKey = cleanText(
    (import.meta.env.VITE_LAST_FM_API_KEY as string | undefined) ??
      (import.meta.env.MAIN_VITE_LAST_FM_API_KEY as string | undefined)
  );
  if (!apiKey) return [];

  const url = new URL(LAST_FM_BASE_URL);
  url.searchParams.set("method", "track.getInfo");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("track", songTitle);
  if (songArtists) url.searchParams.set("artist", songArtists);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return [];
    const payload = (await response.json()) as { track?: Record<string, unknown> };
    const track = payload.track;
    if (!track) return [];

    const title = cleanText(track.name as string);
    const artist = cleanText((track.artist as { name?: string } | undefined)?.name);
    if (!title || !artist) return [];

    const albumTitle = cleanText((track.album as { title?: string } | undefined)?.title);
    const artworkPaths =
      ((track.album as { image?: Array<{ "#text"?: string }> } | undefined)?.image ?? [])
        .map((image) => cleanText(image["#text"]))
        .filter((candidate): candidate is string => Boolean(candidate));
    const sourceId = `${title}:${artist}`;

    return [
      {
        title,
        artists: [artist],
        album: albumTitle,
        artworkPaths,
        source: "LAST_FM",
        sourceId
      }
    ];
  } catch {
    return [];
  }
};

const dedupeHits = (hits: SongMetadataResultFromInternet[]): SongMetadataResultFromInternet[] => {
  const byKey = new Map<string, SongMetadataResultFromInternet>();
  for (const hit of hits) {
    const key = `${hit.source}:${hit.sourceId}`;
    if (!byKey.has(key)) {
      byKey.set(key, hit);
      cacheBySourceId(hit);
    }
  }
  return Array.from(byKey.values());
};

const pickFirstHitPerSource = (
  hits: SongMetadataResultFromInternet[]
): Array<{ source: MetadataSource; hit: SongMetadataResultFromInternet }> => {
  const bySource = new Map<MetadataSource, SongMetadataResultFromInternet>();
  for (const hit of hits) {
    if (!bySource.has(hit.source)) {
      bySource.set(hit.source, hit);
    }
  }
  return Array.from(bySource.entries()).map(([source, hit]) => ({ source, hit }));
};

export const searchSongMetadataResultsInInternet = async (
  songTitle: string,
  songArtists: string[] = []
): Promise<SongMetadataResultFromInternet[]> => {
  const normalizedTitle = cleanText(songTitle);
  if (!normalizedTitle) return [];

  const artistsText = songArtists
    .map((artist) => cleanText(artist))
    .filter((artist): artist is string => Boolean(artist))
    .join(" ");
  const queryKey = buildMetadataQueryKey(normalizedTitle, songArtists);
  const cachedHits = queryKey ? await readCachedHitsForQuery(queryKey) : [];

  const [musixmatch, itunes, genius, deezer, lastFm] = await Promise.all([
    searchMusixmatch(normalizedTitle, artistsText),
    searchItunes(normalizedTitle, artistsText),
    searchGenius(normalizedTitle, artistsText),
    searchDeezer(normalizedTitle, artistsText),
    searchLastFm(normalizedTitle, artistsText)
  ]);

  const deduped = dedupeHits([...musixmatch, ...itunes, ...genius, ...deezer, ...lastFm]);
  if (deduped.length === 0) {
    return cachedHits;
  }

  if (queryKey) {
    const selected = pickFirstHitPerSource(deduped);
    await Promise.all(selected.map(({ source, hit }) => putSelectedSourceHit(source, queryKey, hit)));
  }

  return deduped;
};

const fetchGeniusBySourceId = async (
  sourceId: string
): Promise<SongMetadataResultFromInternet | undefined> => {
  const cached = geniusHitsCache.get(sourceId) ?? inMemorySourceCache.get(`GENIUS:${sourceId}`);
  if (cached) return cached;

  const token = cleanText(
    (import.meta.env.VITE_GENIUS_API_KEY as string | undefined) ??
      (import.meta.env.MAIN_VITE_GENIUS_API_KEY as string | undefined)
  );
  if (!token) return undefined;

  const url = new URL(`/songs/${sourceId}`, GENIUS_BASE_URL);
  try {
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { response?: { song?: Record<string, unknown> } };
    const song = payload.response?.song;
    if (!song) return undefined;

    const title = cleanText(song.title as string);
    const primaryArtist = cleanText((song.primary_artist as { name?: string } | undefined)?.name);
    if (!title || !primaryArtist) return undefined;

    const featured =
      ((song.featured_artists as Array<{ name?: string }> | undefined) ?? [])
        .map((artist) => cleanText(artist.name))
        .filter((artist): artist is string => Boolean(artist));

    const hit: SongMetadataResultFromInternet = {
      title,
      artists: [primaryArtist, ...featured],
      album: cleanText((song.album as { name?: string } | undefined)?.name),
      artworkPaths: [
        cleanText(song.header_image_url as string),
        cleanText(song.song_art_image_url as string),
        cleanText((song.album as { cover_art_url?: string } | undefined)?.cover_art_url)
      ].filter((candidate): candidate is string => Boolean(candidate)),
      releasedYear:
        typeof song.release_date === "string" ? new Date(song.release_date).getFullYear() : undefined,
      source: "GENIUS",
      sourceId
    };
    cacheBySourceId(hit);
    return hit;
  } catch {
    return undefined;
  }
};

const fetchDeezerBySourceId = async (
  sourceId: string
): Promise<SongMetadataResultFromInternet | undefined> => {
  const cached = deezerHitsCache.get(sourceId) ?? inMemorySourceCache.get(`DEEZER:${sourceId}`);
  if (cached) return cached;

  const url = new URL(`/track/${sourceId}`, DEEZER_BASE_URL);
  try {
    const response = await fetch(url.toString());
    if (!response.ok) return undefined;
    const row = (await response.json()) as Record<string, unknown>;

    const title = cleanText(row.title as string);
    if (!title) return undefined;
    const artists =
      ((row.contributors as Array<{ name?: string }> | undefined) ?? [])
        .map((contributor) => cleanText(contributor.name))
        .filter((name): name is string => Boolean(name));
    const artworkPaths = [
      cleanText((row.album as { cover?: string } | undefined)?.cover),
      cleanText((row.album as { cover_small?: string } | undefined)?.cover_small),
      cleanText((row.album as { cover_medium?: string } | undefined)?.cover_medium),
      cleanText((row.album as { cover_big?: string } | undefined)?.cover_big),
      cleanText((row.album as { cover_xl?: string } | undefined)?.cover_xl)
    ].filter((candidate): candidate is string => Boolean(candidate));

    const hit: SongMetadataResultFromInternet = {
      title,
      artists,
      album: cleanText((row.album as { title?: string } | undefined)?.title),
      artworkPaths,
      releasedYear:
        typeof row.release_date === "string" ? new Date(row.release_date).getFullYear() : undefined,
      source: "DEEZER",
      sourceId
    };
    cacheBySourceId(hit);
    return hit;
  } catch {
    return undefined;
  }
};

export const fetchSongMetadataFromInternet = async (
  source: MetadataSource,
  sourceId: string
): Promise<SongMetadataResultFromInternet | undefined> => {
  const key = `${source}:${sourceId}`;
  const cached = inMemorySourceCache.get(key);
  if (cached) return cached;

  if (source === "ITUNES") {
    const itunesHit = iTunesHitsCache.get(sourceId);
    if (itunesHit) return itunesHit;
    return undefined;
  }

  if (source === "GENIUS") {
    return fetchGeniusBySourceId(sourceId);
  }

  if (source === "DEEZER") {
    return fetchDeezerBySourceId(sourceId);
  }

  return undefined;
};
