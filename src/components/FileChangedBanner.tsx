import { Button, Icon, Intent } from "@blueprintjs/core";
import React, { useEffect, useState } from "react";

interface FileChangedBannerProps {
  fileName: string;
  /** File is gone from disk rather than modified. */
  missing: boolean;
  reloading: boolean;
  /** What the user loses by reloading, if anything. */
  warning: string | null;
  onReload: () => void;
  onDismiss: () => void;
}

export function FileChangedBanner({
  fileName,
  missing,
  reloading,
  warning,
  onReload,
  onDismiss,
}: FileChangedBannerProps) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setConfirming(false);
  }, [fileName, missing, warning]);

  if (missing) {
    return (
      <div className="file-changed-banner file-changed-banner-missing">
        <Icon icon="warning-sign" intent={Intent.WARNING} />
        <span className="file-changed-banner-text">
          <strong>{fileName}</strong> is no longer on disk. It may have been moved, renamed, or deleted.
        </span>
        <Button minimal small text="Dismiss" onClick={onDismiss} />
      </div>
    );
  }

  return (
    <div className="file-changed-banner">
      <Icon icon="refresh" intent={Intent.PRIMARY} />
      <span className="file-changed-banner-text">
        {confirming ? (
          <>
            Reload <strong>{fileName}</strong> from disk? {warning}
          </>
        ) : (
          <>
            <strong>{fileName}</strong> changed on disk. Load the new version?
            {warning ? <span className="file-changed-banner-warning"> {warning}</span> : null}
          </>
        )}
      </span>
      {confirming ? (
        <>
          <Button
            small
            intent={Intent.DANGER}
            text="Reload anyway"
            loading={reloading}
            onClick={onReload}
          />
          <Button minimal small text="Cancel" disabled={reloading} onClick={() => setConfirming(false)} />
        </>
      ) : (
        <>
          <Button
            small
            intent={Intent.PRIMARY}
            text="Reload"
            loading={reloading}
            onClick={() => {
              if (warning) {
                setConfirming(true);
                return;
              }
              onReload();
            }}
          />
          <Button minimal small text="Keep mine" disabled={reloading} onClick={onDismiss} />
        </>
      )}
    </div>
  );
}
