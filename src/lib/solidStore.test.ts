import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { createSolidStore } from "./solidStore";

interface Counter {
  count: number;
  label: string | null;
  bump: () => void;
  bumpTwice: () => void;
}

const makeCounter = () =>
  createSolidStore<Counter>((set, get) => ({
    count: 0,
    label: null,
    bump: () => set((s) => ({ count: s.count + 1 })),
    // An action calling a sibling through `get()`, the pattern that made
    // every such call a tracked store read.
    bumpTwice: () => {
      get().bump();
      get().bump();
    },
  }));

describe("createSolidStore", () => {
  test("actions are callable through the store and through get()", () => {
    const store = makeCounter();
    store.bumpTwice();
    flush();
    expect(store.count).toBe(2);
    expect("bump" in store).toBe(true);
  });

  test("actions are not reactive store properties", () => {
    const store = makeCounter();
    // Only the data is in the store, so it alone is enumerable.
    expect(Object.keys(store).toSorted()).toEqual(["count", "label"]);
    // The same function on every read, without a store lookup.
    expect(store.bump).toBe(store.bump);
  });

  // Reactivity is not checked here: `bun test` resolves `solid-js` to its
  // server build (`dist/server.js`), where nothing is reactive, and the store
  // tests in src/stores rely on that build's plain objects. The Playwright
  // harness renders the browser build and covers store → UI updates.

  test("a set that names an action replaces the action", () => {
    let replaced = false;
    // zustand allowed it, so the helper keeps it: the key goes to the action
    // table, never into the reactive store.
    const setter = createSolidStore<{ n: number; act: () => void }>((set) => ({
      n: 0,
      act: () =>
        set({
          act: () => {
            replaced = true;
          },
        }),
    }));
    setter.act();
    flush();
    setter.act();
    expect(replaced).toBe(true);
    expect(Object.keys(setter)).toEqual(["n"]);
  });
});
