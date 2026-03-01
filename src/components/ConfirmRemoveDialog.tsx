interface ConfirmRemoveDialogProps {
  open: boolean;
  sourceName: string;
  onClose: () => void;
  onConfirm: (mode: "unlink" | "delete") => void;
}

export const ConfirmRemoveDialog = ({ open, sourceName, onClose, onConfirm }: ConfirmRemoveDialogProps): JSX.Element | null => {
  if (!open) return null;

  return (
    <div className="dialog-overlay" role="dialog" aria-modal="true">
      <div className="dialog glass">
        <h3>Remove source</h3>
        <p>Choose whether to unlink or delete local contents for "{sourceName}".</p>
        <div className="dialog-actions">
          <button className="chip" onClick={onClose}>
            Cancel
          </button>
          <button className="chip" onClick={() => onConfirm("unlink")}>
            Move to trash
          </button>
          <button className="chip danger" onClick={() => onConfirm("delete")}>
            Delete local contents
          </button>
        </div>
      </div>
    </div>
  );
};
