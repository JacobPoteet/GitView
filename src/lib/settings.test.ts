import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A `localStorage` for Node, which has none. The module reads it once on
 * import, so each test seeds the store, then imports a fresh copy.
 */
function fakeStorage(seed: Record<string, string>) {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    map,
  };
}

async function load(seed: Record<string, string>) {
  const storage = fakeStorage(seed);
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  const mod = await import("./settings");
  return { ...mod, storage };
}

describe("settings", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("reads the defaults with nothing stored, and with no storage at all", async () => {
    const { settings, DEFAULTS } = await load({});
    expect(settings()).toEqual(DEFAULTS);
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const bare = await import("./settings");
    expect(bare.settings()).toEqual(bare.DEFAULTS);
  });

  it("reads each pre-object key once, and removes them all on the next write", async () => {
    const { settings, updateSettings, storage } = await load({
      "gitview.terminal.screenReader": "1",
      "gitview.graph.collapsed": "1",
      "gitview.inbox.mode": "need",
      "gitview.inbox.collapsed": JSON.stringify(["repo:a/b", "need:review"]),
      "gitview.inbox.mergeMethod:a/b": "rebase",
      "gitview.inbox.mergeMethod:c/d": "merge",
      "unrelated": "kept",
    });
    expect(settings().terminal.screenReader).toBe(true);
    expect(settings().graph.collapsed).toBe(true);
    expect(settings().inbox).toEqual({ mode: "need", collapsed: ["repo:a/b", "need:review"] });
    expect(settings().github.mergeMethod).toEqual({ "a/b": "rebase", "c/d": "merge" });

    updateSettings("graph", { collapsed: false });
    expect([...storage.map.keys()].sort()).toEqual(["gitview.settings", "unrelated"]);
    const written = JSON.parse(storage.map.get("gitview.settings")!);
    expect(written.graph.collapsed).toBe(false);
    expect(written.github.mergeMethod).toEqual({ "a/b": "rebase", "c/d": "merge" });
  });

  it("lets the object win over a legacy key it already replaced", async () => {
    const { settings } = await load({
      "gitview.settings": JSON.stringify({ graph: { collapsed: false } }),
      "gitview.graph.collapsed": "1",
    });
    expect(settings().graph.collapsed).toBe(false);
  });

  it("clamps the type size and ignores a legacy collapsed list it cannot parse", async () => {
    const { settings, FONT_SIZE_MAX } = await load({
      "gitview.settings": JSON.stringify({ terminal: { fontSize: 99 } }),
      "gitview.inbox.collapsed": "not json",
    });
    expect(settings().terminal.fontSize).toBe(FONT_SIZE_MAX);
    expect(settings().inbox.collapsed).toEqual([]);
  });

  it("tells a subscriber once per write and replaces the object", async () => {
    const { settings, updateSettings, subscribeSettings } = await load({});
    const before = settings();
    const seen = vi.fn();
    const off = subscribeSettings(seen);
    updateSettings("inbox", { mode: "need" });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(settings()).not.toBe(before);
    expect(settings().inbox.mode).toBe("need");
    off();
    updateSettings("inbox", { mode: "repo" });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
