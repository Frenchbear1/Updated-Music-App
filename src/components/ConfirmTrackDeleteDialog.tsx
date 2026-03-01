interface ConfirmTrackDeleteDialogProps {
  open: boolean;
  trackName: string;
  onClose: () => void;
  onConfirm: (mode: "unlink" | "delete") => void;
}

export const ConfirmTrackDeleteDialog = ({ open, trackName, onClose, onConfirm }: ConfirmTrackDeleteDialogProps): JSX.Element | null => {
  if (!open) return null;

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog glass">
        <h3>Delete track</h3>
        <p>Choose how to remove "{trackName}".</p>
        <div className="dialog-actions">
          <button className="chip" onClick={onClose}>
            Cancel
          </button>
          <button className="chip" onClick={() => onConfirm("unlink")}>
            Move to trash
          </button>
          <button className="chip danger" onClick={() => onConfirm("delete")}>
            Delete from device
          </button>
        </div>
      </div>
    </div>
  );
};
