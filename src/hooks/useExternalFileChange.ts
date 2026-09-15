import { useCallback, useEffect, useRef, useState } from "react";
import type { FileStat } from "../types";
import { subscribeSelfWrite } from "../utils/fileWatch";

type FileSignature = string | null;

function signatureOf(stat: FileStat): FileSignature {
  if (!stat.exists) return null;
  return `${stat.modifiedMs ?? 0}:${stat.size ?? 0}`;
}

export interface ExternalFileChangeState {
  /** File on disk differs from the copy the app loaded. */
  changed: boolean;
  /** File is gone from disk (moved, renamed, or deleted). */
  missing: boolean;
  /** Re-baseline against the current file on disk and clear the notice. */
  resync: () => void;
}

/**
 * Watches a file for out-of-app modifications. Checks when the window regains
 * focus or becomes visible again, so there is no polling or background watcher.
 */
export function useExternalFileChange(filePath: string | null, enabled = true): ExternalFileChangeState {
  const [changed, setChanged] = useState(false);
  const [missing, setMissing] = useState(false);
  const baselineRef = useRef<FileSignature | undefined>(undefined);
  const filePathRef = useRef<string | null>(filePath);
  filePathRef.current = filePath;

  const check = useCallback(async (rebaseline: boolean) => {
    const path = filePathRef.current;
    if (!path || !enabled || typeof window.api?.fileStat !== "function") return;

    let stat: FileStat;
    try {
      stat = await window.api.fileStat(path);
    } catch (err) {
      console.error(`Failed to stat ${path}:`, err);
      return;
    }
    if (filePathRef.current !== path) return;

    const signature = signatureOf(stat);
    if (rebaseline || baselineRef.current === undefined) {
      baselineRef.current = signature;
      setChanged(false);
      setMissing(false);
      return;
    }
    if (signature === baselineRef.current) {
      setChanged(false);
      setMissing(false);
      return;
    }
    setMissing(signature === null);
    setChanged(true);
  }, [enabled]);

  useEffect(() => {
    baselineRef.current = undefined;
    setChanged(false);
    setMissing(false);
    void check(true);
  }, [check, filePath]);

  useEffect(() => {
    if (!filePath || !enabled) return;

    const onFocus = () => void check(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void check(false);
    };
    const onSelfWrite = (writtenPath: string) => {
      if (writtenPath === filePathRef.current) void check(true);
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeSelfWrite = subscribeSelfWrite(onSelfWrite);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeSelfWrite();
    };
  }, [check, enabled, filePath]);

  const resync = useCallback(() => {
    void check(true);
  }, [check]);

  return { changed, missing, resync };
}
