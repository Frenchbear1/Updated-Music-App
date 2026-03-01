import { Heart, Maximize2, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from "lucide-react";
import type { RepeatMode, Track } from "../types/media";

interface MiniPlayerProps {
  track: Track | null;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  progress: number;
  currentTimeSec: number;
  durationSec: number;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (value: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onToggleFavorite: () => void;
  onOpenFullPlayer: () => void;
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

export const MiniPlayer = ({
  track,
  isPlaying,
  shuffle,
  repeat,
  progress,
  currentTimeSec,
  durationSec,
  onTogglePlay,
  onPrev,
  onNext,
  onSeek,
  onToggleShuffle,
  onCycleRepeat,
  onToggleFavorite,
  onOpenFullPlayer
}: MiniPlayerProps): JSX.Element => {
  const parsed = track ? splitTitleArtistFromTrack(track) : null;
  const repeatVisual =
    repeat === "off" ? (
      <Repeat size={16} />
    ) : (
      <span className="repeat-count" aria-hidden="true">
        {repeat === "one" ? "1" : "2"}
      </span>
    );

  return (
    <footer className="mini-player glass">
      <div className="mini-top">
        <div className="mini-left">
          <button className="icon-btn" onClick={onOpenFullPlayer} title="Open player" aria-label="Open full player">
            <Maximize2 size={16} />
          </button>
          <div className="mini-art" aria-hidden="true">
            {track?.artworkUrl ? <img src={track.artworkUrl} alt="" /> : <span>{parsed?.title.slice(0, 2).toUpperCase() ?? "--"}</span>}
          </div>
          <div className="now-playing">
            <strong>{parsed?.title ?? "No track selected"}</strong>
            <span>{parsed?.artist ?? "Import a folder to start"}</span>
          </div>
        </div>

        <div className="mini-center">
          <button className={`icon-btn ${shuffle ? "active-toggle" : ""}`} onClick={onToggleShuffle} aria-label="Toggle shuffle">
            <Shuffle size={16} />
          </button>
          <button className="icon-btn" onClick={onPrev} aria-label="Previous track">
            <SkipBack size={17} />
          </button>
          <button className="icon-btn solid" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button className="icon-btn" onClick={onNext} aria-label="Next track">
            <SkipForward size={17} />
          </button>
          <button className={`icon-btn ${repeat !== "off" ? "active-toggle" : ""}`} onClick={onCycleRepeat} aria-label={`Repeat ${repeat}`}>
            {repeatVisual}
          </button>
        </div>

        <div className="mini-right">
          <button className={`icon-btn favorite-btn ${track?.favorite ? "favorited" : ""}`} onClick={onToggleFavorite} aria-label="Favorite track">
            <Heart size={16} />
          </button>
        </div>
      </div>

      <div className="mini-bottom">
        <span className="mini-time-value">{formatTime(currentTimeSec)}</span>
        <input type="range" min={0} max={100} step="any" value={progress} onChange={(e) => onSeek(Number(e.target.value))} aria-label="Seek" />
        <span className="mini-time-value">{formatTime(durationSec)}</span>
      </div>
    </footer>
  );
};
