import { motion, AnimatePresence } from "framer-motion";
import { Heart, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Trash2, Volume2, X } from "lucide-react";
import type { RepeatMode, Track } from "../types/media";

interface PlayerSheetProps {
  open: boolean;
  track: Track | null;
  artworkUrl?: string | null;
  isPlaying: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  progress: number;
  currentTimeSec: number;
  durationSec: number;
  volume: number;
  onClose: () => void;
  onSeek: (value: number) => void;
  onVolume: (value: number) => void;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleFavorite: () => void;
  onRequestDelete: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
}

const formatTime = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const splitTitleArtistFromTrack = (track: Track): { title: string; artist: string } => {
  const title = track.name?.trim();
  const artist = track.artist?.trim();
  if (title && artist) {
    return { title, artist };
  }

  const base = track.fileName.replace(/\.[^.]+$/, "").trim();
  const parts = base.split(" - ").map((item) => item.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      title: title || parts.slice(0, -1).join(" - "),
      artist: artist || parts[parts.length - 1]
    };
  }
  return {
    title: title || base,
    artist: artist || "Unknown Artist"
  };
};

export const PlayerSheet = ({
  open,
  track,
  artworkUrl,
  isPlaying,
  repeat,
  shuffle,
  progress,
  currentTimeSec,
  durationSec,
  volume,
  onClose,
  onSeek,
  onVolume,
  onTogglePlay,
  onPrev,
  onNext,
  onToggleFavorite,
  onRequestDelete,
  onToggleShuffle,
  onCycleRepeat
}: PlayerSheetProps): JSX.Element => {
  const parsed = track ? splitTitleArtistFromTrack(track) : null;
  const sheetArtworkUrl = artworkUrl?.trim() || track?.artworkUrl?.trim();

  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="player-sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div
            className="player-sheet glass"
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ duration: 0.24 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-head">
              <h2>Now Playing</h2>
              <button className="icon-btn" onClick={onClose} aria-label="Close full player">
                <X size={16} />
              </button>
            </div>

            <div className="sheet-body">
              <div className="sheet-art">
                {sheetArtworkUrl ? <img src={sheetArtworkUrl} alt={`${parsed?.title ?? "Track"} cover art`} /> : parsed ? parsed.title.slice(0, 2).toUpperCase() : "--"}
              </div>

              <div className="sheet-meta">
                <h3>{parsed?.title ?? "No track selected"}</h3>
                <p>{parsed?.artist ?? "Pick a track from library."}</p>
                <button className="icon-btn sheet-remove-btn danger" onClick={onRequestDelete} aria-label="Delete track" disabled={!track}>
                  <Trash2 size={16} />
                </button>
                <button
                  className={`icon-btn favorite-btn sheet-fav-btn ${track?.favorite ? "favorited" : ""}`}
                  onClick={onToggleFavorite}
                  aria-label="Favorite track"
                  disabled={!track}
                >
                  <Heart size={16} />
                </button>
              </div>

              <div className="sheet-seek-wrap">
                <input type="range" min={0} max={100} step="any" value={progress} onChange={(e) => onSeek(Number(e.target.value))} aria-label="Seek" />
                <div className="sheet-time">
                  <span>{formatTime(currentTimeSec)}</span>
                  <span>{formatTime(durationSec)}</span>
                </div>
              </div>

              <div className="sheet-transport">
                <button className="icon-btn sheet-transport-btn" onClick={onPrev} aria-label="Previous track">
                  <SkipBack size={20} />
                </button>
                <button className="icon-btn solid sheet-transport-btn sheet-play-btn" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
                  {isPlaying ? <Pause size={22} /> : <Play size={22} />}
                </button>
                <button className="icon-btn sheet-transport-btn" onClick={onNext} aria-label="Next track">
                  <SkipForward size={20} />
                </button>
              </div>

              <div className="sheet-volume">
                <Volume2 size={15} />
                <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onVolume(Number(e.target.value))} aria-label="Volume" />
              </div>

              <div className="sheet-pills">
                <button className={`pill-btn sheet-pill-icon ${shuffle ? "active" : ""}`} onClick={onToggleShuffle} aria-label="Toggle shuffle" title="Shuffle">
                  <Shuffle size={16} />
                </button>
                <button
                  className={`pill-btn sheet-pill-icon ${repeat !== "off" ? "active" : ""}`}
                  onClick={onCycleRepeat}
                  aria-label={`Repeat ${repeat}`}
                  title={`Repeat ${repeat}`}
                >
                  <Repeat size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
