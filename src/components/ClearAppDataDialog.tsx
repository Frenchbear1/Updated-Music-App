import type { AppDataClearTarget } from "../types/media";

interface ClearAppDataDialogProps {
  open: boolean;
  selectedTargets: AppDataClearTarget[];
  isClearing: boolean;
  onToggleTarget: (target: AppDataClearTarget) => void;
  onClose: () => void;
  onConfirm: () => void;
}

const CLEAR_APP_DATA_OPTIONS: Array<{ id: AppDataClearTarget; title: string; description: string }> = [
  {
    id: "favorites",
    title: "Favorites",
    description: "Unfavorite all songs in the app."
  },
  {
    id: "song_images",
    title: "Song images",
    description: "Remove stored cover art and image cache."
  },
  {
    id: "songs_playlists",
    title: "Songs and playlists",
    description: "Remove your library list from app storage (does not delete music files on disk)."
  },
  {
    id: "trash",
    title: "Trash bin",
    description: "Empty app trash records."
  },
  {
    id: "metadata_cache",
    title: "Metadata cache",
    description: "Clear cached lookup results used for artwork/metadata matching."
  }
];

export const ClearAppDataDialog = ({
  open,
  selectedTargets,
  isClearing,
  onToggleTarget,
  onClose,
  onConfirm
}: ClearAppDataDialogProps): JSX.Element | null => {
  if (!open) return null;

  const selected = new Set(selectedTargets);
  const hasSelection = selectedTargets.length > 0;

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true" onClick={isClearing ? undefined : onClose}>
      <div className="dialog glass clear-app-data-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Clear app data</h3>
        <p className="clear-app-data-note">
          This only clears data stored by this app. It does not delete your real music files from disk.
        </p>

        <div className="clear-app-data-list">
          {CLEAR_APP_DATA_OPTIONS.map((option) => {
            const checkboxId = `clear-app-data-${option.id}`;
            const checked = selected.has(option.id);
            return (
              <label key={option.id} className="clear-app-data-item" htmlFor={checkboxId}>
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleTarget(option.id)}
                  disabled={isClearing}
                />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            );
          })}
        </div>

        <div className="dialog-actions">
          <button className="chip" onClick={onClose} disabled={isClearing}>
            Cancel
          </button>
          <button className="chip danger" onClick={onConfirm} disabled={!hasSelection || isClearing}>
            {isClearing ? "Clearing..." : "Clear selected"}
          </button>
        </div>
      </div>
    </div>
  );
};
