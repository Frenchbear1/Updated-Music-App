interface ConfirmRemoveDialogProps {
  open: boolean;
  sourceName: string;
  onClose: () => void;
  onConfirm: () => void;
}

export const ConfirmRemoveDialog = ({ open, sourceName, onClose, onConfirm }: ConfirmRemoveDialogProps): JSX.Element | null => {
  if (!open) return null;

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog glass">
        <h3>Remove folder</h3>
        <p>Choose whether to move "{sourceName}" to trash or delete its local files.</p>
        <div className="dialog-actions">
          <button className="chip" onClick={onClose}>
            Cancel
          </button>
          <button className="chip" onClick={onConfirm}>
            Move to trash
          </button>
        </div>
      </div>
    </div>
  );
};
