import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ConfirmRemoveDialog } from "./components/ConfirmRemoveDialog";
import { ConfirmTrackDeleteDialog } from "./components/ConfirmTrackDeleteDialog";
import { MiniPlayer } from "./components/MiniPlayer";
import { PlayerSheet } from "./components/PlayerSheet";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { TrackTable } from "./components/TrackTable";
import { TrashDialog } from "./components/TrashDialog";
import type { TrackGroup } from "./components/TrackTable";
import { releaseFullSizeArtworkObjectUrls, resolveTrackArtworkUrl } from "./lib/artworks";
import {
  clearTrash,
  ensureTrackMetadata,
  getLibrary,
  getTrash,
  importCoverExportsFolder,
  importFolder,
  reorderSourcePlaylists,
  refreshSource,
  reportTrackArtworkFailure,
  removeTrack,
  removeSource,
  restoreTrashedSource,
  restoreTrashedTrack,
  resolveTrackFile,
  searchTracks,
  trashSource,
  trashTrack,
  toggleFavorite
} from "./lib/library";
import type { LibrarySource, Playlist, RepeatMode, Track, TrashedSource, TrashedTrack } from "./types/media";

const REPEAT_ORDER: RepeatMode[] = ["off", "one", "two"];
const ARTWORK_PRELOAD_CONCURRENCY = 3;
const sortPlaylists = (items: Playlist[]): Playlist[] => {
  return [...items].sort((a, b) => {
    if (a.sourceId !== b.sourceId) return a.sourceId.localeCompare(b.sourceId);
    const orderDelta = (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    if (orderDelta !== 0) return orderDelta;
    return a.name.localeCompare(b.name);
  });
};

const splitTitleArtistFromFileName = (fileName: string): { title: string; artist: string } => {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const parts = base.split(" - ").map((item) => item.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      title: parts.slice(0, -1).join(" - "),
      artist: parts[parts.length - 1]
    };
  }
  return { title: base, artist: "Unknown Artist" };
};

const buildArtworkPreloadKey = (track: Track): string => {
  return [
    track.isDefaultArtwork ? "default" : "resolved",
    track.artworkId?.trim() || "",
    track.artworkCandidateUrl?.trim() || "",
    String(track.updatedAt ?? 0)
  ].join("|");
};

const App = (): JSX.Element => {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [tab, setTab] = useState<"library" | "favorites">("library");
  const [query, setQuery] = useState("");
  const [searchEverywhere, setSearchEverywhere] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [volume, setVolume] = useState(0.8);
  const [progress, setProgress] = useState(0);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [currentTrackSheetArtworkUrl, setCurrentTrackSheetArtworkUrl] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [isPlayerOpen, setIsPlayerOpen] = useState(false);
  const [pendingRemoveSourceId, setPendingRemoveSourceId] = useState<string | null>(null);
  const [pendingRemoveTrackId, setPendingRemoveTrackId] = useState<string | null>(null);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [trashedSources, setTrashedSources] = useState<TrashedSource[]>([]);
  const [trashedTracks, setTrashedTracks] = useState<TrashedTrack[]>([]);
  const [notice, setNotice] = useState<string>("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const repeatRef = useRef<RepeatMode>("off");
  const goNextRef = useRef<() => void>(() => undefined);
  const artworkFetchInFlightRef = useRef<Set<string>>(new Set());
  const artworkRetryTimeoutRef = useRef<number | null>(null);
  const artworkFailureInFlightRef = useRef<Set<string>>(new Set());
  const currentTrackIdRef = useRef<string | null>(null);
  const tracksByIdRef = useRef<Map<string, Track>>(new Map());
  const artworkPreloadQueueRef = useRef<Array<{ trackId: string; preloadKey: string }>>([]);
  const artworkPreloadQueuedRef = useRef<Map<string, string>>(new Map());
  const artworkPreloadCompletedRef = useRef<Map<string, string>>(new Map());
  const artworkPreloadRunningRef = useRef(false);

  const loadLibrary = async (): Promise<void> => {
    const snapshot = await getLibrary();
    const playlistMap = new Map(snapshot.playlists.map((playlist) => [playlist.id, playlist]));
    setSources(snapshot.sources);
    setPlaylists(sortPlaylists(snapshot.playlists));
    setTracks(
      snapshot.tracks.map((track) => {
        const parsed = splitTitleArtistFromFileName(track.fileName);
        const playlistName = playlistMap.get(track.playlistId)?.name;
        return {
          ...track,
          name: track.name?.trim() || parsed.title || track.name,
          artist: track.artist?.trim() || parsed.artist || track.artist,
          album: track.album || playlistName || "Unknown Album"
        };
      })
    );
    setSelectedPlaylistId((current) => {
      if (snapshot.playlists.length === 0) return null;
      if (current && snapshot.playlists.some((playlist) => playlist.id === current)) return current;
      return snapshot.playlists[0].id;
    });
  };

  const loadTrash = async (): Promise<void> => {
    const snapshot = await getTrash();
    setTrashedSources(snapshot.sources);
    setTrashedTracks(snapshot.tracks);
  };

  useEffect(() => {
    void loadLibrary();
    void loadTrash();
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = volume;

    const onTime = (): void => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        setProgress(0);
        setCurrentTimeSec(0);
        setDurationSec(0);
        return;
      }
      setProgress((audio.currentTime / audio.duration) * 100);
      setCurrentTimeSec(audio.currentTime);
      setDurationSec(audio.duration);
    };

    const onEnded = (): void => {
      if (repeatRef.current === "two") {
        repeatRef.current = "one";
        setRepeat("one");
        audio.currentTime = 0;
        void audio.play();
        return;
      }

      if (repeatRef.current === "one") {
        repeatRef.current = "off";
        setRepeat("off");
        audio.currentTime = 0;
        void audio.play();
        return;
      }
      goNextRef.current();
    };

    const onPause = (): void => setIsPlaying(false);
    const onPlay = (): void => setIsPlaying(true);
    const onLoadedMeta = (): void => {
      setDurationSec(Number.isFinite(audio.duration) ? audio.duration : 0);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("loadedmetadata", onLoadedMeta);

    audioRef.current = audio;

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("loadedmetadata", onLoadedMeta);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    repeatRef.current = repeat;
  }, [repeat]);

  useEffect(() => {
    currentTrackIdRef.current = currentTrackId;
  }, [currentTrackId]);

  useEffect(() => {
    tracksByIdRef.current = new Map(tracks.map((track) => [track.id, track]));
  }, [tracks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        const target = document.activeElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          return;
        }
        event.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        input?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
      if (artworkRetryTimeoutRef.current !== null) {
        window.clearTimeout(artworkRetryTimeoutRef.current);
        artworkRetryTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !isPlaying) {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const tick = (): void => {
      const duration = audio.duration;
      if (Number.isFinite(duration) && duration > 0) {
        setCurrentTimeSec(audio.currentTime);
        setDurationSec(duration);
        setProgress((audio.currentTime / duration) * 100);
      }
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isPlaying, currentTrackId]);

  const selectedTracks = useMemo(() => {
    if (tab === "library" && searchEverywhere && query.trim()) {
      return searchTracks(tracks, query);
    }

    const base =
      tab === "favorites"
        ? tracks.filter((track) => track.favorite)
        : selectedPlaylistId
          ? tracks.filter((track) => track.playlistId === selectedPlaylistId)
          : tracks;

    return searchTracks(base, query);
  }, [tab, tracks, selectedPlaylistId, query, searchEverywhere]);

  const groupedSearchResults = useMemo<TrackGroup[] | undefined>(() => {
    if (!(tab === "library" && searchEverywhere && query.trim())) {
      return undefined;
    }

    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const playlistMap = new Map(playlists.map((playlist) => [playlist.id, playlist]));
    const groups = new Map<string, TrackGroup>();

    for (const track of selectedTracks) {
      const playlist = playlistMap.get(track.playlistId);
      if (!playlist) continue;
      const sourceName = sourceMap.get(playlist.sourceId)?.name ?? "Unknown Source";
      const existing = groups.get(playlist.id);
      if (existing) {
        existing.tracks.push(track);
        continue;
      }

      groups.set(playlist.id, {
        id: playlist.id,
        title: playlist.name,
        subtitle: sourceName,
        tracks: [track]
      });
    }

    const ordered: TrackGroup[] = [];
    for (const playlist of playlists) {
      const group = groups.get(playlist.id);
      if (group) {
        ordered.push(group);
      }
    }
    return ordered;
  }, [tab, searchEverywhere, query, selectedTracks, playlists, sources]);

  const currentTrack = useMemo(() => tracks.find((track) => track.id === currentTrackId) ?? null, [tracks, currentTrackId]);

  useEffect(() => {
    releaseFullSizeArtworkObjectUrls(currentTrack?.artworkId);
    const fallbackUrl = currentTrack?.artworkUrl ?? null;
    setCurrentTrackSheetArtworkUrl(fallbackUrl);

    if (!currentTrack?.artworkId || currentTrack.isDefaultArtwork) {
      return;
    }

    let cancelled = false;
    void resolveTrackArtworkUrl(currentTrack, "full")
      .then((fullUrl) => {
        if (cancelled) return;
        setCurrentTrackSheetArtworkUrl(fullUrl ?? fallbackUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentTrackSheetArtworkUrl(fallbackUrl);
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentTrack?.id,
    currentTrack?.artworkId,
    currentTrack?.artworkUpdatedAt,
    currentTrack?.artworkUrl,
    currentTrack?.isDefaultArtwork
  ]);

  const artworkStatus = useMemo(() => {
    const total = tracks.length;
    if (total === 0) {
      return { total: 0, remaining: 0, percent: 100 };
    }
    const loaded = tracks.filter((track) => !track.isDefaultArtwork).length;
    const remaining = Math.max(0, total - loaded);
    const percent = Math.round((loaded / total) * 100);
    return { total, remaining, percent };
  }, [tracks]);

  const queueFromVisibleTracks = (): string[] => selectedTracks.map((track) => track.id);

  const setNoticeText = (message: string): void => {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(""), 2600);
  };

  const applyTrackPatch = (nextTrack: Track): void => {
    setTracks((current) => {
      let changed = false;
      const next = current.map((track) => {
        if (track.id !== nextTrack.id) return track;
        const trackChanged =
          track.name !== nextTrack.name ||
          track.artist !== nextTrack.artist ||
          track.album !== nextTrack.album ||
          track.artworkUrl !== nextTrack.artworkUrl ||
          track.isDefaultArtwork !== nextTrack.isDefaultArtwork ||
          track.artworkId !== nextTrack.artworkId;
        if (trackChanged) {
          changed = true;
          return nextTrack;
        }
        return track;
      });
      return changed ? next : current;
    });
  };

  const clearArtworkRetryTimer = (): void => {
    if (artworkRetryTimeoutRef.current !== null) {
      window.clearTimeout(artworkRetryTimeoutRef.current);
      artworkRetryTimeoutRef.current = null;
    }
  };

  const requestArtworkOnce = async (trackId: string, signal?: AbortSignal): Promise<Track | null> => {
    if (artworkFetchInFlightRef.current.has(trackId)) return null;

    artworkFetchInFlightRef.current.add(trackId);
    try {
      const enriched = await ensureTrackMetadata(trackId, { signal });
      if (enriched) {
        applyTrackPatch(enriched);
      }
      return enriched;
    } catch {
      return null;
    } finally {
      artworkFetchInFlightRef.current.delete(trackId);
    }
  };

  const pumpArtworkPreloadQueue = (): void => {
    if (artworkPreloadRunningRef.current) return;
    if (artworkPreloadQueueRef.current.length === 0) return;

    artworkPreloadRunningRef.current = true;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const next = artworkPreloadQueueRef.current.shift();
        if (!next) return;

        const queuedKey = artworkPreloadQueuedRef.current.get(next.trackId);
        if (queuedKey !== next.preloadKey) continue;
        artworkPreloadQueuedRef.current.delete(next.trackId);

        const queuedTrack = tracksByIdRef.current.get(next.trackId);
        if (!queuedTrack) continue;

        if (!queuedTrack.isDefaultArtwork) {
          artworkPreloadCompletedRef.current.set(next.trackId, buildArtworkPreloadKey(queuedTrack));
          continue;
        }

        await requestArtworkOnce(next.trackId).catch(() => null);

        const updatedTrack = tracksByIdRef.current.get(next.trackId);
        if (updatedTrack) {
          artworkPreloadCompletedRef.current.set(next.trackId, buildArtworkPreloadKey(updatedTrack));
        }
      }
    };

    void Promise.all(Array.from({ length: ARTWORK_PRELOAD_CONCURRENCY }, () => runWorker()))
      .catch(() => undefined)
      .finally(() => {
        artworkPreloadRunningRef.current = false;
        if (artworkPreloadQueueRef.current.length > 0) {
          pumpArtworkPreloadQueue();
        }
      });
  };

  useEffect(() => {
    const activeIds = new Set(tracks.map((track) => track.id));

    for (const queuedId of Array.from(artworkPreloadQueuedRef.current.keys())) {
      if (!activeIds.has(queuedId)) {
        artworkPreloadQueuedRef.current.delete(queuedId);
      }
    }

    for (const completedId of Array.from(artworkPreloadCompletedRef.current.keys())) {
      if (!activeIds.has(completedId)) {
        artworkPreloadCompletedRef.current.delete(completedId);
      }
    }

    artworkPreloadQueueRef.current = artworkPreloadQueueRef.current.filter((entry) => {
      if (!activeIds.has(entry.trackId)) return false;
      const queuedKey = artworkPreloadQueuedRef.current.get(entry.trackId);
      return queuedKey === entry.preloadKey;
    });

    for (const track of tracks) {
      if (!track.isDefaultArtwork) continue;
      const preloadKey = buildArtworkPreloadKey(track);
      if (artworkPreloadCompletedRef.current.get(track.id) === preloadKey) continue;
      if (artworkPreloadQueuedRef.current.get(track.id) === preloadKey) continue;
      if (artworkFetchInFlightRef.current.has(track.id)) continue;

      artworkPreloadQueuedRef.current.set(track.id, preloadKey);
      artworkPreloadQueueRef.current.push({
        trackId: track.id,
        preloadKey
      });
    }

    pumpArtworkPreloadQueue();
  }, [tracks]);

  const requestArtworkWithRetry = (trackId: string, attempt = 0): void => {
    const maxAttempts = 5;
    void requestArtworkOnce(trackId)
      .then((enriched) => {
        const existingTrack = tracksByIdRef.current.get(trackId);
        const hasArtwork = Boolean(
          (enriched && !enriched.isDefaultArtwork) ||
            (existingTrack && !existingTrack.isDefaultArtwork)
        );
        if (!hasArtwork && currentTrackIdRef.current === trackId && attempt < maxAttempts) {
          const delayMs = attempt === 0 ? 2500 : 5000;
          artworkRetryTimeoutRef.current = window.setTimeout(() => {
            artworkRetryTimeoutRef.current = null;
            requestArtworkWithRetry(trackId, attempt + 1);
          }, delayMs);
        }
      });
  };

  const onArtworkError = (trackId: string, artworkUrl: string): void => {
    const track = tracksByIdRef.current.get(trackId);
    const currentArtwork = track?.artworkUrl?.trim();
    if (!track || track.isDefaultArtwork || !currentArtwork) return;
    if (artworkUrl.trim() && currentArtwork !== artworkUrl.trim()) return;
    if (artworkFailureInFlightRef.current.has(trackId)) return;

    artworkFailureInFlightRef.current.add(trackId);

    setTracks((current) =>
      current.map((item) => (item.id === trackId ? { ...item, artworkUrl: undefined } : item))
    );

    void reportTrackArtworkFailure(trackId, currentArtwork)
      .then((updated) => {
        if (updated) {
          applyTrackPatch(updated);
        }
      })
      .finally(() => {
        artworkFailureInFlightRef.current.delete(trackId);
      });
  };

  const playTrack = async (track: Track): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      const file = await resolveTrackFile(track);
      const nextUrl = URL.createObjectURL(file);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = nextUrl;

      audio.src = nextUrl;
      await audio.play();
      setCurrentTrackId(track.id);
      currentTrackIdRef.current = track.id;
      setQueue(queueFromVisibleTracks());
      setProgress(0);
      setCurrentTimeSec(0);
      clearArtworkRetryTimer();
      requestArtworkWithRetry(track.id);
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Unable to play this track");
    }
  };

  const togglePlay = async (): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!currentTrackId) {
      const first = selectedTracks[0];
      if (first) await playTrack(first);
      return;
    }

    if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
  };

  const goToQueueTrack = async (direction: -1 | 1): Promise<void> => {
    if (!currentTrackId) return;
    const activeQueue = queue.length > 0 ? queue : queueFromVisibleTracks();
    if (activeQueue.length === 0) return;

    if (shuffle && direction > 0) {
      const options = activeQueue.filter((id) => id !== currentTrackId);
      const randomId = options[Math.floor(Math.random() * options.length)] ?? activeQueue[0];
      const nextTrack = tracks.find((track) => track.id === randomId);
      if (nextTrack) await playTrack(nextTrack);
      return;
    }

    const currentIndex = activeQueue.indexOf(currentTrackId);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex + direction;
    if (nextIndex < 0) {
      nextIndex = 0;
    }
    if (nextIndex >= activeQueue.length) {
      nextIndex = 0;
    }

    const nextId = activeQueue[nextIndex];
    const nextTrack = tracks.find((track) => track.id === nextId);
    if (nextTrack) await playTrack(nextTrack);
  };

  const goPrev = (): void => {
    void goToQueueTrack(-1);
  };

  const goNext = (): void => {
    void goToQueueTrack(1);
  };

  useEffect(() => {
    goNextRef.current = goNext;
  }, [goNext]);

  const onSeek = (value: number): void => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = (value / 100) * audio.duration;
    setProgress(value);
    setCurrentTimeSec(audio.currentTime);
  };

  const onImport = async (): Promise<void> => {
    if (!("showDirectoryPicker" in window)) {
      setNoticeText("This browser does not support folder import APIs");
      return;
    }

    try {
      await importFolder();
      await loadLibrary();
      setNoticeText("Folder imported");
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Import canceled");
    }
  };

  const onImportCoverDatabase = async (): Promise<void> => {
    if (!("showDirectoryPicker" in window)) {
      setNoticeText("This browser does not support folder import APIs");
      return;
    }

    try {
      const imported = await importCoverExportsFolder();
      await loadLibrary();
      setNoticeText(
        `Cover DB imported: ${imported.cacheEntries} mappings, ${imported.tracksUpdated} tracks updated`
      );
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Cover import canceled");
    }
  };

  const onRefreshAll = async (): Promise<void> => {
    for (const source of sources) {
      try {
        await refreshSource(source.id);
      } catch {
        // Continue refreshing remaining sources.
      }
    }
    await loadLibrary();
    setNoticeText("Library refresh completed");
  };

  const onRemoveSource = (sourceId: string): void => {
    setPendingRemoveSourceId(sourceId);
  };

  const onReorderPlaylists = (sourceId: string, orderedPlaylistIds: string[]): void => {
    setPlaylists((current) => {
      const sourcePlaylists = current.filter((playlist) => playlist.sourceId === sourceId);
      if (sourcePlaylists.length <= 1) return current;

      const byId = new Map(sourcePlaylists.map((playlist) => [playlist.id, playlist]));
      const ordered: Playlist[] = [];
      for (const id of orderedPlaylistIds) {
        const playlist = byId.get(id);
        if (playlist) {
          ordered.push(playlist);
          byId.delete(id);
        }
      }
      const remainder = Array.from(byId.values());
      const nextForSource = [...ordered, ...remainder].map((playlist, index) => ({ ...playlist, order: index }));
      const others = current.filter((playlist) => playlist.sourceId !== sourceId);
      return sortPlaylists([...others, ...nextForSource]);
    });

    void reorderSourcePlaylists(sourceId, orderedPlaylistIds).catch((error) => {
      setNoticeText(error instanceof Error ? error.message : "Unable to save folder order");
      void loadLibrary();
    });
  };

  const onConfirmRemove = async (mode: "unlink" | "delete"): Promise<void> => {
    if (!pendingRemoveSourceId) return;

    try {
      const removedTrackIds = new Set(tracks.filter((track) => track.sourceId === pendingRemoveSourceId).map((track) => track.id));
      if (mode === "unlink") {
        await trashSource(pendingRemoveSourceId);
      } else {
        await removeSource(pendingRemoveSourceId, mode);
      }

      if (currentTrackId && removedTrackIds.has(currentTrackId)) {
        stopPlayback();
      } else {
        setQueue((current) => current.filter((id) => !removedTrackIds.has(id)));
      }

      await loadLibrary();
      await loadTrash();
      setNoticeText(mode === "unlink" ? "Folder moved to trash" : "Local contents deleted and source removed");
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Remove failed");
    } finally {
      setPendingRemoveSourceId(null);
    }
  };

  const stopPlayback = (): void => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    clearArtworkRetryTimer();
    setCurrentTrackId(null);
    currentTrackIdRef.current = null;
    setQueue([]);
    setProgress(0);
    setCurrentTimeSec(0);
    setDurationSec(0);
  };

  const onConfirmTrackDelete = async (mode: "unlink" | "delete"): Promise<void> => {
    if (!pendingRemoveTrackId) return;

    try {
      const removedTrack = tracks.find((track) => track.id === pendingRemoveTrackId);
      const wasCurrent = currentTrackId === pendingRemoveTrackId;
      if (mode === "unlink") {
        await trashTrack(pendingRemoveTrackId);
      } else {
        await removeTrack(pendingRemoveTrackId, mode);
      }
      if (wasCurrent) {
        stopPlayback();
      } else {
        setQueue((current) => current.filter((id) => id !== pendingRemoveTrackId));
      }
      await loadLibrary();
      await loadTrash();
      setNoticeText(
        mode === "unlink"
          ? "Track moved to trash"
          : `"${removedTrack?.name ?? "Track"}" deleted from device`
      );
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setPendingRemoveTrackId(null);
    }
  };

  const onToggleFavorite = async (trackId: string): Promise<void> => {
    await toggleFavorite(trackId);
    setTracks((current) => current.map((track) => (track.id === trackId ? { ...track, favorite: !track.favorite } : track)));
  };

  const cycleRepeat = (): void => {
    const index = REPEAT_ORDER.indexOf(repeat);
    setRepeat(REPEAT_ORDER[(index + 1) % REPEAT_ORDER.length]);
  };

  const onRestoreSourceFromTrash = async (trashId: string): Promise<void> => {
    try {
      await restoreTrashedSource(trashId);
      await loadLibrary();
      await loadTrash();
      setNoticeText("Folder restored");
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Restore failed");
    }
  };

  const onRestoreTrackFromTrash = async (trashId: string): Promise<void> => {
    try {
      await restoreTrashedTrack(trashId);
      await loadLibrary();
      await loadTrash();
      setNoticeText("Track restored");
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Restore failed");
    }
  };

  const onClearTrash = async (): Promise<void> => {
    try {
      await clearTrash();
      await loadTrash();
      setNoticeText("Trash emptied");
    } catch (error) {
      setNoticeText(error instanceof Error ? error.message : "Unable to clear trash");
    }
  };

  const pendingSource = sources.find((source) => source.id === pendingRemoveSourceId);

  return (
    <div className="app-shell">
      <Sidebar
        sources={sources}
        playlists={playlists}
        selectedPlaylistId={selectedPlaylistId}
        onSelectPlaylist={setSelectedPlaylistId}
        onImport={onImport}
        onImportCoverDatabase={onImportCoverDatabase}
        onRefreshAll={onRefreshAll}
        onRemoveSource={onRemoveSource}
        onReorderPlaylists={onReorderPlaylists}
      />

      <main className="main-pane">
        <TopBar
          query={query}
          onQueryChange={setQuery}
          tab={tab}
          onTabChange={(nextTab) => {
            setTab(nextTab);
            if (nextTab !== "library") {
              setSearchEverywhere(false);
            }
          }}
          searchEverywhere={searchEverywhere}
          onToggleSearchEverywhere={() => setSearchEverywhere((value) => !value)}
          onOpenTrash={() => setIsTrashOpen(true)}
          artworkPercent={artworkStatus.percent}
          artworkRemaining={artworkStatus.remaining}
          artworkTotal={artworkStatus.total}
        />

        <AnimatePresence mode="wait">
          <motion.section
            className="content-view"
            key={`${tab}-${selectedPlaylistId ?? "all"}-${query}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            <TrackTable
              tracks={selectedTracks}
              groups={groupedSearchResults}
              currentTrackId={currentTrackId}
              onPlay={(track) => {
                void playTrack(track);
              }}
              onToggleFavorite={(trackId) => {
                void onToggleFavorite(trackId);
              }}
              onArtworkError={onArtworkError}
            />
          </motion.section>
        </AnimatePresence>

        <MiniPlayer
          track={currentTrack}
          isPlaying={isPlaying}
          shuffle={shuffle}
          repeat={repeat}
          progress={progress}
          currentTimeSec={currentTimeSec}
          durationSec={durationSec}
          onTogglePlay={() => {
            void togglePlay();
          }}
          onPrev={goPrev}
          onNext={goNext}
          onSeek={onSeek}
          onToggleShuffle={() => setShuffle((value) => !value)}
          onCycleRepeat={cycleRepeat}
          onToggleFavorite={() => {
            if (currentTrack) {
              void onToggleFavorite(currentTrack.id);
            }
          }}
          onOpenFullPlayer={() => setIsPlayerOpen(true)}
        />
      </main>

      <PlayerSheet
        open={isPlayerOpen}
        track={currentTrack}
        artworkUrl={currentTrackSheetArtworkUrl}
        isPlaying={isPlaying}
        repeat={repeat}
        shuffle={shuffle}
        progress={progress}
        currentTimeSec={currentTimeSec}
        durationSec={durationSec}
        volume={volume}
        onClose={() => setIsPlayerOpen(false)}
        onSeek={onSeek}
        onVolume={setVolume}
        onTogglePlay={() => {
          void togglePlay();
        }}
        onPrev={goPrev}
        onNext={goNext}
        onToggleFavorite={() => {
          if (currentTrack) {
            void onToggleFavorite(currentTrack.id);
          }
        }}
        onRequestDelete={() => {
          if (currentTrack) {
            setPendingRemoveTrackId(currentTrack.id);
          }
        }}
        onToggleShuffle={() => setShuffle((value) => !value)}
        onCycleRepeat={cycleRepeat}
      />

      <ConfirmRemoveDialog
        open={Boolean(pendingSource)}
        sourceName={pendingSource?.name ?? ""}
        onClose={() => setPendingRemoveSourceId(null)}
        onConfirm={(mode) => {
          void onConfirmRemove(mode);
        }}
      />

      <ConfirmTrackDeleteDialog
        open={Boolean(pendingRemoveTrackId)}
        trackName={tracks.find((track) => track.id === pendingRemoveTrackId)?.name ?? "this track"}
        onClose={() => setPendingRemoveTrackId(null)}
        onConfirm={(mode) => {
          void onConfirmTrackDelete(mode);
        }}
      />

      <TrashDialog
        open={isTrashOpen}
        trashedSources={trashedSources}
        trashedTracks={trashedTracks}
        onClose={() => setIsTrashOpen(false)}
        onRestoreSource={(trashId) => {
          void onRestoreSourceFromTrash(trashId);
        }}
        onRestoreTrack={(trashId) => {
          void onRestoreTrackFromTrash(trashId);
        }}
        onClearAll={() => {
          void onClearTrash();
        }}
      />

      <AnimatePresence>
        {notice ? (
          <motion.div className="toast" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {notice}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export default App;
