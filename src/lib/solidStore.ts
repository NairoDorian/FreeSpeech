import { createRoot, createStore, reconcile, type Store } from "solid-js";

/**
 * A `set` update: either a partial to shallow-merge into the store, or a
 * function of the current state that returns the partial to merge.
 *
 * This is the shape zustand's `set` had, and it is kept because the stores in
 * `src/stores/` were written against it. What changed underneath is the
 * engine: these are now Solid stores, not zustand stores, so the app can be
 * rendered by Solid without React's hook dispatcher in the loop.
 */
export type StoreUpdate<T> = Partial<T> | ((state: T) => Partial<T> | void);

export type StoreSet<T> = (update: StoreUpdate<T>) => void;

const isPlain = (value: unknown): value is object => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Whether `next` can be reconciled into the store node `current` rather than
 * replacing it: both plain objects or both arrays, and — for a keyed object —
 * the same `id`, since `reconcile` refuses a root of a different identity.
 */
function mergeable(current: unknown, next: unknown): boolean {
  if (current === next || !isPlain(current) || !isPlain(next)) return false;
  if (Array.isArray(current) !== Array.isArray(next)) return false;
  if (Array.isArray(next)) return true;
  const before = (current as { id?: unknown }).id;
  return before === undefined || before === (next as { id?: unknown }).id;
}

/**
 * Create a module-level Solid store with zustand's `set`/`get` ergonomics.
 *
 * Why this exists. The React → Solid 2 migration (see CHANGELOG) converted the
 * zustand stores to `createStore`. The stores carry real logic — `settingsStore`
 * alone is hundreds of lines of async IPC sequencing — and rewriting every `set(...)` /
 * `get()` call inside those bodies into draft mutations would have been a
 * large, mechanical, easy-to-get-subtly-wrong diff with no behavioural upside.
 * This helper supplies the two functions the bodies already call, on top of
 * Solid's own `createStore`, so the bodies are preserved verbatim:
 *
 *   - `set(partial)`    → `setState(draft => Object.assign(draft, partial))`
 *   - `set(fn)`         → the updater reads the draft and its result is merged
 *   - `get()`           → the store, through the facade described below
 *
 * The store is created inside a detached `createRoot` so it has an owner for
 * the lifetime of the module. These are app-lifetime singletons — the app has
 * no server renderer, so the "one module instance is shared across requests"
 * caveat in the Solid docs does not apply.
 *
 * **Actions are not state.** The initializer returns data and functions in one
 * object (zustand's shape), but only the data goes into the Solid store. The
 * functions are kept beside it, and the returned object is a thin facade that
 * answers an action key from that table and everything else from the store.
 * Putting the functions in the store made every `store.refreshSettings` /
 * `get().initialize` a tracked store read: outside a tracking scope (a
 * component body, an effect's apply half, an action calling its siblings)
 * Solid 2 reports each one as `STRICT_READ_UNTRACKED`, about a fifth of all
 * the diagnostics a test run printed, and inside one it subscribed the caller
 * to a property that never changes. A `set` that names an action key
 * replaces the function in the table, so the zustand semantics hold.
 *
 * **Object fields are merged, not replaced.** The bodies update nested state
 * the zustand way, `set({ settings: { ...state.settings, [key]: value } })`,
 * and assigning that fresh object made every reader of `settings` re-run for
 * the one leaf that moved (Solid 2's IMMUTABLE_UPDATE_IN_STORE). When the
 * field already holds a plain object or array and the new value is the same
 * kind, `set` reconciles the new value into it instead (`reconcile`, keyed by
 * `id`): the store ends up equal to the new value either way, but only the
 * leaves that changed notify, and list rows with a matching `id` keep their
 * identity. A keyed object whose `id` changed, a class instance, or a type
 * change is assigned as before.
 */
export function createSolidStore<T extends object>(
  initializer: (set: StoreSet<T>, get: () => T) => T,
): Store<T> {
  let facade!: Store<T>;
  let commit!: (fn: (draft: T) => void) => void;
  const actions: Record<PropertyKey, unknown> = {};

  const get = () => facade;
  const set: StoreSet<T> = (update) => {
    commit((draft) => {
      const partial =
        typeof update === "function"
          ? (update as (current: T) => Partial<T> | void)(draft as T)
          : update;
      if (!partial) return;
      const target = draft as Record<string, unknown>;
      for (const [key, value] of Object.entries(partial)) {
        if (Object.hasOwn(actions, key)) actions[key] = value;
        else if (mergeable(target[key], value))
          reconcile(value as object, "id")(target[key] as object);
        else target[key] = value;
      }
    });
  };

  createRoot(() => {
    // The initial object is built **before** the store exists and handed to
    // `createStore` as its initial value, rather than being written in
    // afterwards. Two reasons, both load-bearing:
    //
    //   1. `initializer` only *defines* actions — it never calls `get()` or
    //      `set` while building the object — so the store it closes over does
    //      not have to exist yet.
    //   2. A write made after `createStore` would be **staged**: Solid commits
    //      store writes on the next microtask flush, so between module
    //      evaluation and that flush the store would read back empty. Any
    //      module-scope consumer (`main.tsx` calling `initialize()`) would then
    //      see a store with no actions on it. The initial value has no such
    //      delay.
    const initial = initializer(set, get);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(initial)) {
      if (typeof value === "function") actions[key] = value;
      else data[key] = value;
    }
    // `as never` because `createStore`'s overloads reject a bare `T` that could
    // itself be callable.
    const [store, setStore] = createStore<T>(data as never);
    commit = setStore as unknown as (fn: (draft: T) => void) => void;
    facade = new Proxy(store as object, {
      get: (target, key) =>
        Object.hasOwn(actions, key)
          ? actions[key]
          : (target as Record<PropertyKey, unknown>)[key],
      has: (target, key) => Object.hasOwn(actions, key) || key in target,
    }) as Store<T>;
  });

  return facade;
}
