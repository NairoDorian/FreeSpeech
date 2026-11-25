/**
 * The live toast queue `components/ui/Toaster.tsx` renders.
 *
 * It is a plain Solid store rather than a `createSolidStore` one because nothing
 * here needs actions: the app's own API is `lib/sessionToast.ts`, which wraps
 * `show` / `dismiss` and additionally records errors and warnings for the Debug
 * page. `id` is a module-level counter, never reused, so a dismissal can never
 * remove a toast that arrived after it.
 */

import { createStore } from "solid-js";

export type ToastLevel = "success" | "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  description?: string;
  action?: ToastAction;
}

export interface ToastContent extends ToastOptions {
  message: string;
}

export interface ToastRecord extends ToastContent {
  id: number;
  level: ToastLevel;
}

interface ToastStore {
  toasts: ToastRecord[];
}

/**
 * How many toasts are on screen at once. A new toast past the limit drops the
 * oldest one here, where it is added, rather than in an effect that watched
 * the queue and dismissed the overflow after the fact (one extra render of the
 * whole list per toast, and every read in its untracked apply half flagged).
 */
export const VISIBLE_TOASTS = 3;

let nextToastId = 1;

const [toastStore, setToastStore] = createStore<ToastStore>({
  toasts: [],
});

// Draft writes, the Solid 2 store setter's own form: only the entries that
// change notify, and `<For>` keeps the rows of the toasts that stay.
export function show(level: ToastLevel, content: ToastContent): number {
  const id = nextToastId++;
  setToastStore((state) => {
    state.toasts.push({ id, level, ...content });
    const overflow = state.toasts.length - VISIBLE_TOASTS;
    if (overflow > 0) state.toasts.splice(0, overflow);
  });
  return id;
}

export function dismiss(id: number): void {
  setToastStore((state) => {
    const index = state.toasts.findIndex((toast) => toast.id === id);
    if (index >= 0) state.toasts.splice(index, 1);
  });
}

export function useToastStore() {
  return toastStore;
}
