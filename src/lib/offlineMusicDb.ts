import type { Track } from "../types/media";

interface AcoustIdEntry {
  fingerprint: string;
  recordingId: string;
  score?: number;
}

interface MusicBrainzRecordingEntry {
  recordingId: string;
  releaseId?: string;
  title: string;
  artist?: string;
  album?: string;
}

interface CoverArtEntry {
  releaseId: string;
  artworkDataUrl?: string;
  artworkUrl?: string;
  artworkPath?: string;
}

interface OfflineMusicDb {
  byFingerprint: Map<string, string>;
  recordingsById: Map<string, MusicBrainzRecordingEntry>;
  byTrackKey: Map<string, MusicBrainzRecordingEntry[]>;
  byTitle: Map<string, MusicBrainzRecordingEntry[]>;
  coversByReleaseId: Map<string, string>;
}

interface LocalArtworkMatch {
  album?: string;
  artworkUrl?: string;
  musicBrainzRecordingId?: string;
  musicBrainzReleaseId?: string;
}

const ACOUSTID_DB_URL = "/databases/acoustid.json";
const MUSICBRAINZ_DB_URL = "/databases/musicbrainz-recordings.json";
const COVER_ART_DB_URL = "/databases/coverart.json";

let offlineDbPromise: Promise<OfflineMusicDb> | null = null;

const normalizeForMatch = (value?: string): string => value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";

const buildTrackKey = (title?: string, artist?: string): string => {
  const titleKey = normalizeForMatch(title);
  if (!titleKey) return "";
  const artistKey = normalizeForMatch(artist);
  return artistKey ? `${titleKey}::${artistKey}` : titleKey;
};

const fetchJsonOrEmpty = async <T>(url: string, fallback: T): Promise<T> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
};

const ensureArray = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  return value as T[];
};

const toCoverUrl = (entry: CoverArtEntry): string | undefined => {
  const dataUrl = entry.artworkDataUrl?.trim();
  if (dataUrl) return dataUrl;

  const directUrl = entry.artworkUrl?.trim();
  if (directUrl) return directUrl;

  const path = entry.artworkPath?.trim();
  if (!path) return undefined;
  if (path.startsWith("/") || path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `/databases/covers/${path}`;
};

const scoreRecordingMatch = (track: Track, candidate: MusicBrainzRecordingEntry): number => {
  const normalizedTrackTitle = normalizeForMatch(track.name);
  const normalizedTrackArtist = normalizeForMatch(track.artist);
  const normalizedTrackAlbum = normalizeForMatch(track.album);

  const normalizedCandidateTitle = normalizeForMatch(candidate.title);
  const normalizedCandidateArtist = normalizeForMatch(candidate.artist);
  const normalizedCandidateAlbum = normalizeForMatch(candidate.album);

  let score = 0;
  if (normalizedTrackTitle && normalizedTrackTitle === normalizedCandidateTitle) score += 6;
  if (normalizedTrackArtist && normalizedTrackArtist === normalizedCandidateArtist) score += 3;
  if (normalizedTrackAlbum && normalizedTrackAlbum === normalizedCandidateAlbum) score += 2;
  return score;
};

const getBestRecordingCandidate = (track: Track, candidates: MusicBrainzRecordingEntry[]): MusicBrainzRecordingEntry | null => {
  if (candidates.length === 0) return null;
  let best: MusicBrainzRecordingEntry | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreRecordingMatch(track, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best ?? candidates[0];
};

const resolveTrackFingerprint = (track: Track): string | undefined => {
  const normalized = track.acoustIdFingerprint?.trim();
  return normalized || undefined;
};

const loadOfflineMusicDb = async (): Promise<OfflineMusicDb> => {
  const [rawAcoustId, rawRecordings, rawCoverArt] = await Promise.all([
    fetchJsonOrEmpty<unknown>(ACOUSTID_DB_URL, []),
    fetchJsonOrEmpty<unknown>(MUSICBRAINZ_DB_URL, []),
    fetchJsonOrEmpty<unknown>(COVER_ART_DB_URL, [])
  ]);

  const acoustIdEntries = ensureArray<AcoustIdEntry>(rawAcoustId);
  const recordingEntries = ensureArray<MusicBrainzRecordingEntry>(rawRecordings);
  const coverArtEntries = ensureArray<CoverArtEntry>(rawCoverArt);

  const byFingerprint = new Map<string, string>();
  for (const entry of acoustIdEntries) {
    const fingerprint = entry.fingerprint?.trim();
    const recordingId = entry.recordingId?.trim();
    if (!fingerprint || !recordingId) continue;
    if (!byFingerprint.has(fingerprint)) {
      byFingerprint.set(fingerprint, recordingId);
    }
  }

  const recordingsById = new Map<string, MusicBrainzRecordingEntry>();
  const byTrackKey = new Map<string, MusicBrainzRecordingEntry[]>();
  const byTitle = new Map<string, MusicBrainzRecordingEntry[]>();
  for (const entry of recordingEntries) {
    const recordingId = entry.recordingId?.trim();
    if (!recordingId) continue;

    const normalizedEntry: MusicBrainzRecordingEntry = {
      recordingId,
      releaseId: entry.releaseId?.trim() || undefined,
      title: entry.title?.trim() || "",
      artist: entry.artist?.trim() || undefined,
      album: entry.album?.trim() || undefined
    };
    if (!normalizedEntry.title) continue;

    recordingsById.set(recordingId, normalizedEntry);

    const key = buildTrackKey(normalizedEntry.title, normalizedEntry.artist);
    if (key) {
      const existing = byTrackKey.get(key);
      if (existing) {
        existing.push(normalizedEntry);
      } else {
        byTrackKey.set(key, [normalizedEntry]);
      }
    }

    const titleKey = normalizeForMatch(normalizedEntry.title);
    if (titleKey) {
      const existing = byTitle.get(titleKey);
      if (existing) {
        existing.push(normalizedEntry);
      } else {
        byTitle.set(titleKey, [normalizedEntry]);
      }
    }
  }

  const coversByReleaseId = new Map<string, string>();
  for (const entry of coverArtEntries) {
    const releaseId = entry.releaseId?.trim();
    if (!releaseId) continue;
    const coverUrl = toCoverUrl(entry);
    if (!coverUrl) continue;
    coversByReleaseId.set(releaseId, coverUrl);
  }

  return {
    byFingerprint,
    recordingsById,
    byTrackKey,
    byTitle,
    coversByReleaseId
  };
};

const getOfflineMusicDb = async (): Promise<OfflineMusicDb> => {
  if (!offlineDbPromise) {
    offlineDbPromise = loadOfflineMusicDb();
  }
  return offlineDbPromise;
};

const resolveRecordingFromTrack = (track: Track, db: OfflineMusicDb): MusicBrainzRecordingEntry | null => {
  const knownRecording = track.musicBrainzRecordingId?.trim();
  if (knownRecording) {
    return db.recordingsById.get(knownRecording) ?? null;
  }

  const fingerprint = resolveTrackFingerprint(track);
  if (fingerprint) {
    const recordingId = db.byFingerprint.get(fingerprint);
    if (recordingId) {
      const byFingerprint = db.recordingsById.get(recordingId);
      if (byFingerprint) return byFingerprint;
    }
  }

  const exactKey = buildTrackKey(track.name, track.artist);
  if (exactKey) {
    const exactCandidates = db.byTrackKey.get(exactKey);
    if (exactCandidates?.length) {
      return getBestRecordingCandidate(track, exactCandidates);
    }
  }

  const titleKey = normalizeForMatch(track.name);
  if (titleKey) {
    const titleCandidates = db.byTitle.get(titleKey);
    if (titleCandidates?.length) {
      return getBestRecordingCandidate(track, titleCandidates);
    }
  }

  return null;
};

export const resolveArtworkFromLocalDatabase = async (track: Track): Promise<LocalArtworkMatch | null> => {
  const db = await getOfflineMusicDb();
  const recording = resolveRecordingFromTrack(track, db);
  if (!recording) return null;

  const releaseId = recording.releaseId?.trim() || track.musicBrainzReleaseId?.trim();
  const artworkUrl = releaseId ? db.coversByReleaseId.get(releaseId) : undefined;
  const album = recording.album?.trim() || track.album;
  if (!album && !artworkUrl && !recording.recordingId) return null;

  return {
    album: album || undefined,
    artworkUrl,
    musicBrainzRecordingId: recording.recordingId || undefined,
    musicBrainzReleaseId: releaseId || undefined
  };
};

