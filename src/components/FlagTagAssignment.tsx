import { useMemo, useState } from "react";
import { Search } from "lucide-react";

export type TagFlag = { key: string; label: string; description?: string };
export type TagEntity = { key: string; label: string; sublabel?: string };

export interface FlagTagAssignmentProps {
  entityPickerLabel: string;
  entities: TagEntity[];
  flagUniverse: TagFlag[];
  getAssignedKeys: (entityKey: string) => string[];
  onAssign: (entityKey: string, keys: string[]) => Promise<void>;
  onUnassign: (entityKey: string, keys: string[]) => Promise<void>;
  saving?: boolean;
  searchPlaceholder?: string;
  entityEmptyMessage?: string;
}

// A generic "tag an entity (role or user) with flags (capabilities or pages)"
// UI — pick one entity, see a searchable alphabetical two-column list
// (available flags on the left, currently-assigned on the right), check/
// select to move flags between them. Owns only UI/interaction state; all
// persistence is delegated to the caller via onAssign/onUnassign, since the
// three real call sites (Permissions/By Role, Permissions/By User, Menu
// Access) each store their data completely differently.
export function FlagTagAssignment({
  entityPickerLabel,
  entities,
  flagUniverse,
  getAssignedKeys,
  onAssign,
  onUnassign,
  saving = false,
  searchPlaceholder = "Search Flag name",
  entityEmptyMessage = "No options available.",
}: FlagTagAssignmentProps) {
  const [selectedEntityKey, setSelectedEntityKey] = useState("");
  const [search, setSearch] = useState("");
  const [leftChecked, setLeftChecked] = useState<Set<string>>(new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(new Set());

  const assignedSet = useMemo(
    () => new Set(selectedEntityKey ? getAssignedKeys(selectedEntityKey) : []),
    [selectedEntityKey, getAssignedKeys],
  );

  const matchesSearch = (f: TagFlag) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q);
  };

  const available = useMemo(
    () =>
      flagUniverse
        .filter((f) => !assignedSet.has(f.key) && matchesSearch(f))
        .sort((a, b) => a.label.localeCompare(b.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flagUniverse, assignedSet, search],
  );
  const assigned = useMemo(
    () =>
      flagUniverse
        .filter((f) => assignedSet.has(f.key) && matchesSearch(f))
        .sort((a, b) => a.label.localeCompare(b.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flagUniverse, assignedSet, search],
  );

  const allLeftChecked = available.length > 0 && available.every((f) => leftChecked.has(f.key));
  const allRightChecked = assigned.length > 0 && assigned.every((f) => rightChecked.has(f.key));

  function selectEntity(key: string) {
    setSelectedEntityKey(key);
    setSearch("");
    setLeftChecked(new Set());
    setRightChecked(new Set());
  }

  function toggleLeft(key: string) {
    setLeftChecked((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function toggleRight(key: string) {
    setRightChecked((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function toggleAllLeft() {
    setLeftChecked(allLeftChecked ? new Set() : new Set(available.map((f) => f.key)));
  }
  function toggleAllRight() {
    setRightChecked(allRightChecked ? new Set() : new Set(assigned.map((f) => f.key)));
  }

  async function handleAssignSelected() {
    if (!selectedEntityKey || leftChecked.size === 0) return;
    await onAssign(selectedEntityKey, [...leftChecked]);
    setLeftChecked(new Set());
  }
  async function handleUnassignSelected() {
    if (!selectedEntityKey || rightChecked.size === 0) return;
    await onUnassign(selectedEntityKey, [...rightChecked]);
    setRightChecked(new Set());
  }
  async function handleUnassignOne(key: string) {
    if (!selectedEntityKey) return;
    await onUnassign(selectedEntityKey, [key]);
    setRightChecked((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }

  const disabled = !selectedEntityKey || saving;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {entityPickerLabel}
          </label>
          <select
            value={selectedEntityKey}
            onChange={(e) => selectEntity(e.target.value)}
            className="w-full h-9 px-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">[ Select ]</option>
            {entities.map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
                {e.sublabel ? ` — ${e.sublabel}` : ""}
              </option>
            ))}
          </select>
          {entities.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">{entityEmptyMessage}</p>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Search Flag name
          </label>
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full h-9 pl-8 pr-3 rounded-md border bg-card text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Available flags */}
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground px-3 py-2 flex items-center justify-between">
            <span>Flag</span>
            <span>Description</span>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y">
            {available.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                {selectedEntityKey ? "No matching flags." : "Select above to begin."}
              </p>
            ) : (
              available.map((f) => (
                <label
                  key={f.key}
                  className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-muted/40 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={leftChecked.has(f.key)}
                    onChange={() => toggleLeft(f.key)}
                    disabled={disabled}
                    className="mt-0.5"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="font-medium block">{f.label}</span>
                    {f.description && (
                      <span className="text-xs text-muted-foreground">{f.description}</span>
                    )}
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/20">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={allLeftChecked}
                onChange={toggleAllLeft}
                disabled={disabled || available.length === 0}
              />
              Select All
            </label>
            <button
              type="button"
              onClick={handleAssignSelected}
              disabled={disabled || leftChecked.size === 0}
              className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              Select.
            </button>
          </div>
        </div>

        {/* Assigned flags */}
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground px-3 py-2 flex items-center justify-between">
            <span>Flag</span>
            <span></span>
          </div>
          <div className="max-h-80 overflow-y-auto divide-y">
            {assigned.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                {selectedEntityKey ? "No flags assigned yet." : "Select above to begin."}
              </p>
            ) : (
              assigned.map((f) => (
                <div key={f.key} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={rightChecked.has(f.key)}
                    onChange={() => toggleRight(f.key)}
                    disabled={disabled}
                  />
                  <span className="flex-1 min-w-0 font-medium">{f.label}</span>
                  <button
                    type="button"
                    onClick={() => handleUnassignOne(f.key)}
                    disabled={disabled}
                    className="text-xs text-blue-600 hover:underline disabled:opacity-50 shrink-0"
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/20">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={allRightChecked}
                onChange={toggleAllRight}
                disabled={disabled || assigned.length === 0}
              />
              Select All
            </label>
            <button
              type="button"
              onClick={handleUnassignSelected}
              disabled={disabled || rightChecked.size === 0}
              className="h-8 px-4 rounded-md border bg-card text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
