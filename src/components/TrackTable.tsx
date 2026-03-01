import { Heart, Play } from "lucide-react";
import type { Track } from "../types/media";

export interface TrackGroup {
  id: string;
  title: string;
  subtitle: string;
  tracks: Track[];
}

interface TrackTableProps {
  tracks: Track[];
  groups?: TrackGroup[];
  currentTrackId: string | null;
  onPlay: (track: Track) => void;
  onToggleFavorite: (trackId: string) => void;
  onArtworkError: (trackId: string, artworkUrl: string) => void;
}

export const TrackTable = ({
  tracks,
  groups,
  currentTrackId,
  onPlay,
  onToggleFavorite,
  onArtworkError
}: TrackTableProps): JSX.Element => {
  const resolveTitle = (track: Track): string => {
    if (track.name?.trim()) return track.name.trim();
    const base = track.fileName.replace(/\.[^.]+$/, "").trim();
    const parts = base.split(" - ").map((item) => item.trim()).filter(Boolean);
    return parts.length >= 2 ? parts.slice(0, -1).join(" - ") : track.name;
  };

  const resolveArtist = (track: Track): string => {
    if (track.artist?.trim()) return track.artist.trim();
    const base = track.fileName.replace(/\.[^.]+$/, "").trim();
    const parts = base.split(" - ").map((item) => item.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 1] : "Unknown Artist";
  };

  const hasGroups = Boolean(groups && groups.length > 0);
  const hasTracks = tracks.length > 0;

  if (!hasTracks && !hasGroups) {
    return <div className="empty-panel glass">No tracks match this view yet.</div>;
  }

  let rowIndex = 0;
  const renderTrackRow = (track: Track): JSX.Element => {
    const isCurrent = track.id === currentTrackId;
    const thisIndex = rowIndex;
    rowIndex += 1;
    const animationDelayMs = Math.min(thisIndex * 35, 280);
    const title = resolveTitle(track);
    const artist = resolveArtist(track);
    const artwork = track.artworkUrl?.trim();
    const hasArtwork = Boolean(artwork);

    return (
      <div
        className={`track-row ${isCurrent ? "current" : ""}`}
        key={track.id}
        style={{ animationDelay: `${animationDelayMs}ms` }}
        role="button"
        tabIndex={0}
        aria-label={`Play ${title}`}
        onClick={() => onPlay(track)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onPlay(track);
          }
        }}
      >
        <button
          className={`track-play ${hasArtwork ? "has-artwork" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onPlay(track);
          }}
          aria-label={`Play ${title}`}
        >
          {hasArtwork ? (
            <img
              src={artwork}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none";
                onArtworkError(track.id, artwork ?? "");
              }}
            />
          ) : (
            <Play size={14} />
          )}
        </button>
        <div className="track-meta">
          <strong>{title}</strong>
          <span>{artist}</span>
        </div>
        <button
          className={`icon-btn favorite-btn ${track.favorite ? "favorited" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(track.id);
          }}
          aria-label={`Toggle favorite for ${title}`}
          title="Favorite"
        >
          <Heart size={16} />
        </button>
      </div>
    );
  };

  return (
    <div className="track-list glass">
      {hasGroups
        ? groups!.map((group) => (
            <section key={group.id} className="search-group-card">
              <header className="search-group-head">
                <strong>{group.title}</strong>
                <span>{group.subtitle}</span>
              </header>
              <div className="search-group-rows">
                {group.tracks.map((track) => renderTrackRow(track))}
              </div>
            </section>
          ))
        : tracks.map((track) => renderTrackRow(track))}
    </div>
  );
};
