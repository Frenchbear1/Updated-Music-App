import type { TrashedSource, TrashedTrack } from "../types/media";
import { RefreshCw } from "lucide-react";

interface TrashDialogProps {
  open: boolean;
  trashedSources: TrashedSource[];
  trashedTracks: TrashedTrack[];
  onClose: () => void;
  onRestoreSource: (trashId: string) => void;
  onRestoreTrack: (trashId: string) => void;
  onClearAll: () => void;
}

export const TrashDialog = ({
  open,
  trashedSources,
  trashedTracks,
  onClose,
  onRestoreSource,
  onRestoreTrack,
  onClearAll
}: TrashDialogProps): JSX.Element | null => {
  if (!open) return null;

  const hasItems = trashedSources.length > 0 || trashedTracks.length > 0;

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="dialog glass trash-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Trash Bin</h3>
        {!hasItems ? <p>Trash is empty.</p> : null}

        {trashedSources.length > 0 ? (
          <div className="trash-section">
            <div className="section-label">Folders</div>
            <div className="trash-list">
              {trashedSources.map((item) => (
                <div key={item.id} className="trash-row">
                  <div className="trash-meta">
                    <strong>{item.source.name}</strong>
                    <span>{item.tracks.length} songs</span>
                  </div>
                  <button className="icon-btn trash-restore-btn" onClick={() => onRestoreSource(item.id)} aria-label="Restore folder" title="Restore folder">
                    <RefreshCw size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {trashedTracks.length > 0 ? (
          <div className="trash-section">
            <div className="section-label">Songs</div>
            <div className="trash-list">
              {trashedTracks.map((item) => (
                <div key={item.id} className="trash-row">
                  <div className="trash-meta">
                    <strong>{item.track.name || item.track.fileName}</strong>
                    <span>
                      {item.sourceName} / {item.playlistName}
                    </span>
                  </div>
                  <button className="icon-btn trash-restore-btn" onClick={() => onRestoreTrack(item.id)} aria-label="Restore track" title="Restore track">
                    <RefreshCw size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="dialog-actions">
          <button className="chip" onClick={onClose}>
            Close
          </button>
          <button className="chip danger" onClick={onClearAll} disabled={!hasItems}>
            Remove All
          </button>
        </div>
      </div>
    </div>
  );
};
