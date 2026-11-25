import { createSignal, createEffect, createMemo, Show } from "solid-js";

import { getVersion } from "@tauri-apps/api/app";
import { useSettings } from "../../hooks/useSettings";
import { findReleaseNoteToShow } from "./releaseNotes";
import type { ReleaseNote } from "./releaseNotes";
import { WhatsNewModal } from "./WhatsNewModal";

export const WhatsNewGate = () => {
  const { settings, isLoading, updateSetting } = useSettings();
  const [note, setNote] = createSignal<ReleaseNote | null>(null);
  const [isOpen, setIsOpen] = createSignal(false);
  let dismissedVersionRef: string | null = null;

  // The two settings the gate depends on, as plain values. The memo is the
  // dependency list: it re-evaluates once settings load (they are null at
  // mount) and on every settings refresh — each one replaces the whole node —
  // but its `equals` passes the effect only a change in one of these fields.
  // The effect's apply phase is untracked, so it is handed values rather than
  // the settings store to read fields from.
  const gate = createMemo(
    () => {
      const current = settings();
      return {
        ready: !isLoading() && current !== null,
        enabled: current?.show_whats_new_on_update ?? false,
        lastSeenVersion: current?.whats_new_last_seen_version ?? "",
      };
    },
    {
      equals: (a, b) =>
        a.ready === b.ready &&
        a.enabled === b.enabled &&
        a.lastSeenVersion === b.lastSeenVersion,
    },
  );
  createEffect(
    () => gate(),
    ({ ready, enabled, lastSeenVersion }) => {
      if (!ready || !enabled) {
        setIsOpen(false);
        setNote(null);
        return;
      }

      let cancelled = false;

      const loadReleaseNote = async () => {
        try {
          const currentVersion = await getVersion();
          if (cancelled) return;

          const releaseNote = findReleaseNoteToShow({
            currentVersion,
            lastSeenVersion,
          });

          if (!releaseNote || dismissedVersionRef === releaseNote.version) {
            setIsOpen(false);
            setNote(null);
            return;
          }

          setNote(releaseNote);
          setIsOpen(true);
        } catch (error) {
          console.error("Failed to load release notes:", error);
        }
      };

      void loadReleaseNote();

      return () => {
        cancelled = true;
      };
    },
  );

  const dismiss = () => {
    const current = note();
    if (!current) return;

    dismissedVersionRef = current.version;
    setIsOpen(false);
    void updateSetting("whats_new_last_seen_version", current.version);
  };

  // Read inside the Show binding, not the body: a body-level `note()` would
  // snapshot the initial null and the modal could never open.
  return (
    <Show when={note()}>
      <WhatsNewModal note={note()!} open={isOpen()} onDismiss={dismiss} />
    </Show>
  );
};
