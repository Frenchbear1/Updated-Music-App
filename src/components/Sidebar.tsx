import { FolderPlus, GripVertical, Music2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Reorder } from "framer-motion";
import type { LibrarySource, Playlist } from "../types/media";

interface SidebarProps {
  sources: LibrarySource[];
  playlists: Playlist[];
  librarySummaryText: string;
  selectedPlaylistId: string | null;
  onSelectPlaylist: (id: string) => void;
  isRefreshing: boolean;
  isRefreshDisabled: boolean;
  onImport: () => void;
  onRefreshAll: () => void;
  onBulkRemovePlaylists: (playlistIds: string[]) => void;
  onReorderPlaylists: (sourceId: string, orderedPlaylistIds: string[]) => void;
}

export const Sidebar = ({
  sources,
  playlists,
  librarySummaryText,
  selectedPlaylistId,
  onSelectPlaylist,
  isRefreshing,
  isRefreshDisabled,
  onImport,
  onRefreshAll,
  onBulkRemovePlaylists,
  onReorderPlaylists
}: SidebarProps): JSX.Element => {
  const [editMode, setEditMode] = useState(false);
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<string[]>([]);

  useEffect(() => {
    const validIds = new Set(playlists.map((playlist) => playlist.id));
    setSelectedPlaylistIds((current) => current.filter((id) => validIds.has(id)));
  }, [playlists]);

  useEffect(() => {
    if (!editMode) {
      setSelectedPlaylistIds([]);
    }
  }, [editMode]);

  const reorderAcrossFlatList = (orderedPlaylistIds: string[]): void => {
    const byPlaylistId = new Map(playlists.map((playlist) => [playlist.id, playlist]));
    const grouped = new Map<string, string[]>();

    for (const playlistId of orderedPlaylistIds) {
      const playlist = byPlaylistId.get(playlistId);
      if (!playlist) continue;
      const existing = grouped.get(playlist.sourceId);
      if (existing) {
        existing.push(playlistId);
      } else {
        grouped.set(playlist.sourceId, [playlistId]);
      }
    }

    for (const [sourceId, ids] of grouped) {
      onReorderPlaylists(sourceId, ids);
    }
  };

  const togglePlaylistSelection = (playlistId: string): void => {
    setSelectedPlaylistIds((current) =>
      current.includes(playlistId)
        ? current.filter((id) => id !== playlistId)
        : [...current, playlistId]
    );
  };

  const hasBulkSelection = selectedPlaylistIds.length > 0;

  return (
    <aside className={`sidebar glass ${sources.length > 0 ? "has-footer" : ""}`}>
      <div className="sidebar-header">
        <h1>PulseDeck</h1>
        <div className="sidebar-head-actions">
          {editMode ? (
            <button
              className="icon-btn danger bulk-remove-chip"
              onClick={() => onBulkRemovePlaylists(selectedPlaylistIds)}
              disabled={!hasBulkSelection}
              title={hasBulkSelection ? `Move ${selectedPlaylistIds.length} selected folders to trash` : "Select folders to bulk delete"}
              aria-label={hasBulkSelection ? `Bulk delete ${selectedPlaylistIds.length} folders` : "Select folders to bulk delete"}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            onClick={onRefreshAll}
            title={isRefreshing ? "Refreshing library" : "Refresh all"}
            aria-label={isRefreshing ? "Refreshing library" : "Refresh all"}
            disabled={isRefreshDisabled}
          >
            <RefreshCw size={16} className={isRefreshing ? "spin-icon" : undefined} />
          </button>
          <button
            className={`icon-btn ${editMode ? "active-toggle" : ""}`}
            onClick={() => setEditMode((value) => !value)}
            title="Edit library"
            aria-label="Edit library"
          >
            <Pencil size={16} />
          </button>
          <button className="icon-btn" onClick={onImport} title="Import folders" aria-label="Import folders">
            <FolderPlus size={18} />
          </button>
        </div>
      </div>

      <div className="section-label">Library</div>

      {sources.length === 0 ? (
        <p className="empty-note">Import a folder or files to create your first playlist.</p>
      ) : (
        <>
          {editMode ? (
            <Reorder.Group axis="y" values={playlists.map((playlist) => playlist.id)} onReorder={reorderAcrossFlatList} className="playlist-list playlist-reorder">
              {playlists.map((playlist) => (
                <Reorder.Item
                  key={playlist.id}
                  value={playlist.id}
                  className="playlist-reorder-item"
                  whileDrag={{
                    scale: 1.02,
                    boxShadow: "0 10px 24px rgba(12, 32, 35, 0.18)"
                  }}
                >
                  <div className="playlist-row">
                    <label className="playlist-check-wrap" title={`Select ${playlist.name}`} onPointerDown={(event) => event.stopPropagation()}>
                      <input
                        className="playlist-check"
                        type="checkbox"
                        checked={selectedPlaylistIds.includes(playlist.id)}
                        onChange={() => togglePlaylistSelection(playlist.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </label>
                    <button
                      className={`playlist-btn drag-enabled ${selectedPlaylistId === playlist.id ? "active" : ""}`}
                      onClick={() => onSelectPlaylist(playlist.id)}
                      title={playlist.name}
                    >
                      <GripVertical size={14} />
                      <span>{playlist.name}</span>
                    </button>
                  </div>
                </Reorder.Item>
              ))}
            </Reorder.Group>
          ) : (
            <ul className="playlist-list">
              {playlists.map((playlist) => (
                <li key={playlist.id}>
                  <div className="playlist-row">
                    <button
                      className={`playlist-btn ${selectedPlaylistId === playlist.id ? "active" : ""}`}
                      onClick={() => onSelectPlaylist(playlist.id)}
                      title={playlist.name}
                    >
                      <Music2 size={14} />
                      <span>{playlist.name}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {sources.length > 0 ? <div className="sidebar-footer-floating">{librarySummaryText}</div> : null}
    </aside>
  );
};
