import { Globe2, Heart, MoreVertical, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TopBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  tab: "library" | "favorites";
  onTabChange: (tab: "library" | "favorites") => void;
  searchEverywhere: boolean;
  onToggleSearchEverywhere: () => void;
  onOpenTrash: () => void;
  artworkPercent: number;
  artworkRemaining: number;
  artworkTotal: number;
}

export const TopBar = ({
  query,
  onQueryChange,
  tab,
  onTabChange,
  searchEverywhere,
  onToggleSearchEverywhere,
  onOpenTrash,
  artworkPercent,
  artworkRemaining,
  artworkTotal
}: TopBarProps): JSX.Element => {
  const showSearchEverywhere = tab === "library" && query.trim().length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  return (
    <header className="topbar glass">
      <div className="search-wrap">
        <Search size={16} />
        <input
          id="search-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search tracks"
          aria-label="Search tracks"
        />
      </div>

      <div className="topbar-actions">
        {showSearchEverywhere ? (
          <button
            className={`chip ${searchEverywhere ? "active" : ""}`}
            onClick={onToggleSearchEverywhere}
            aria-label="Toggle search everywhere"
            title="Search all folders"
          >
            <Globe2 size={14} />
            Search Everywhere
          </button>
        ) : null}
        <button
          className={`chip ${tab === "library" ? "active" : ""}`}
          onClick={() => onTabChange("library")}
          aria-label="Library tab"
        >
          Library
        </button>
        <button
          className={`chip ${tab === "favorites" ? "active" : ""}`}
          onClick={() => onTabChange("favorites")}
          aria-label="Favorites tab"
        >
          <Heart size={14} />
          Favorites
        </button>
        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" title="Library options" aria-label="Library options" onClick={() => setMenuOpen((value) => !value)}>
            <MoreVertical size={17} />
          </button>
          {menuOpen ? (
            <div className="menu-popup glass">
              {artworkTotal > 0 ? <div className="menu-status">Covers {artworkPercent}% ({artworkRemaining} left)</div> : null}
              <button
                className="menu-item-btn"
                onClick={() => {
                  onOpenTrash();
                  setMenuOpen(false);
                }}
              >
                <Trash2 size={15} />
                Open trash
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
};
