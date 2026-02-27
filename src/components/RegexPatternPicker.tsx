import React, { useState, useCallback } from "react";
import { Button, InputGroup, Icon, Intent } from "@blueprintjs/core";
import { Popover2 } from "@blueprintjs/popover2";
import { RegexPattern } from "../types";

interface RegexPatternPickerProps {
  onSelect: (pattern: string) => void;
  onOpenManager: () => void;
}

const CATEGORY_ORDER = ["Numbers", "Contact", "Web", "Date/Time", "Text", "My Patterns"];

export function RegexPatternPicker({ onSelect, onOpenManager }: RegexPatternPickerProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [patterns, setPatterns] = useState<RegexPattern[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadPatterns = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    try {
      const all = await window.api.getRegexPatterns();
      setPatterns(all);
      setLoaded(true);
    } catch (err) {
      console.error("Failed to load patterns:", err);
    } finally {
      setLoading(false);
    }
  }, [loaded]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setSearch("");
    loadPatterns();
  }, [loadPatterns]);

  const handleSelect = useCallback((pattern: string) => {
    onSelect(pattern);
    setIsOpen(false);
  }, [onSelect]);

  const handleManage = useCallback(() => {
    setIsOpen(false);
    onOpenManager();
  }, [onOpenManager]);

  // Refresh patterns (called after manager closes)
  const refresh = useCallback(() => {
    setLoaded(false);
  }, []);

  // Group patterns by category
  const filtered = search
    ? patterns.filter((p) =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.pattern.toLowerCase().includes(search.toLowerCase()) ||
        (p.description && p.description.toLowerCase().includes(search.toLowerCase()))
      )
    : patterns;

  const grouped = new Map<string, RegexPattern[]>();
  for (const p of filtered) {
    const cat = p.isBuiltin ? (p.category || "Other") : "My Patterns";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(p);
  }

  // Sort by category order
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const popoverContent = (
    <div className="regex-picker-popover">
      <div className="regex-picker-search">
        <InputGroup
          leftIcon="search"
          placeholder="Search patterns..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          small
          autoFocus
        />
      </div>
      <div className="regex-picker-list">
        {loading && (
          <div className="regex-picker-loading">Loading patterns...</div>
        )}
        {!loading && sortedCategories.length === 0 && (
          <div className="regex-picker-empty">No patterns found</div>
        )}
        {sortedCategories.map((cat) => (
          <div key={cat} className="regex-picker-category">
            <div className="regex-picker-category-label">{cat}</div>
            {grouped.get(cat)!.map((p) => (
              <div
                key={p.id}
                className="regex-picker-item"
                onClick={() => handleSelect(p.pattern)}
                title={p.description}
              >
                <span className="regex-picker-item-title">{p.title}</span>
                <code className="regex-picker-item-pattern">{p.pattern}</code>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="regex-picker-footer">
        <Button
          minimal
          small
          icon="cog"
          text="Manage Patterns..."
          onClick={handleManage}
        />
      </div>
    </div>
  );

  return (
    <Popover2
      content={popoverContent}
      isOpen={isOpen}
      onInteraction={(nextOpen) => {
        if (nextOpen) handleOpen();
        else setIsOpen(false);
      }}
      placement="bottom-end"
      minimal
    >
      <Button
        icon="manual"
        minimal
        small
        title="Pattern library"
        intent={Intent.NONE}
      />
    </Popover2>
  );
}

// Export refresh helper type for parent components
export type RegexPickerRefreshFn = () => void;
