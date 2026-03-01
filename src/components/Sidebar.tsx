import { FolderPlus, ImagePlus, Music2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Reorder } from "framer-motion";
import type { LibrarySource, Playlist } from "../types/media";

interface SidebarProps {
  sources: LibrarySource[];
  playlists: Playlist[];
  selectedPlaylistId: string | null;
  onSelectPlaylist: (id: string) => void;
  onImport: () => void;
  onImportCoverDatabase: () => void;
  onRefreshAll: () => void;
  onRemoveSource: (id: string) => void;
  onReorderPlaylists: (sourceId: string, orderedPlaylistIds: string[]) => void;
}

export const Sidebar = ({
  sources,
  playlists,
  selectedPlaylistId,
  onSelectPlaylist,
  onImport,
  onImportCoverDatabase,
  onRefreshAll,
  onRemoveSource,
  onReorderPlaylists
}: SidebarProps): JSX.Element => {
  const [editMode, setEditMode] = useState(false);

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

  return (
    <aside className="sidebar glass">
      <div className="sidebar-header">
        <h1>PulseDeck</h1>
        <div className="sidebar-head-actions">
          <button className="icon-btn" onClick={onRefreshAll} title="Refresh all" aria-label="Refresh all">
            <RefreshCw size={16} />
          </button>
          <button
            className={`icon-btn ${editMode ? "active-toggle" : ""}`}
            onClick={() => setEditMode((value) => !value)}
            title="Edit library"
            aria-label="Edit library"
          >
            <Pencil size={16} />
          </button>
          <button className="icon-btn" onClick={onImport} title="Import folder" aria-label="Import folder">
            <FolderPlus size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={onImportCoverDatabase}
            title="Import covers database"
            aria-label="Import covers database"
          >
            <ImagePlus size={18} />
          </button>
        </div>
      </div>

      <div className="section-label">Library</div>

      {sources.length === 0 ? (
        <p className="empty-note">Import a folder to create your first playlist.</p>
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
                    <button
                      className={`playlist-btn drag-enabled ${selectedPlaylistId === playlist.id ? "active" : ""}`}
                      onClick={() => onSelectPlaylist(playlist.id)}
                      title={playlist.name}
                    >
                      <Music2 size={14} />
                      <span>{playlist.name}</span>
                    </button>
                    <div className="playlist-actions">
                      <button
                        className="icon-btn danger"
                        onClick={() => onRemoveSource(playlist.sourceId)}
                        title="Remove source"
                        aria-label={`Remove ${playlist.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
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
    </aside>
  );
};
