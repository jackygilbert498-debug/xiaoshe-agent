import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows Bridge acceptance runner", () => {
  it("binds every action to the isolated acceptance controls", async () => {
    const source = await readFile(resolve("scripts/run-windows-bridge-acceptance.mjs"), "utf8");

    expect(source).toContain("Xiaoshe Windows Acceptance");
    expect(source).toContain("XIAOSHE_SAFE_BUTTON");
    expect(source).toContain("XIAOSHE_FOCUS_INPUT");
    expect(source).toContain("list_windows");
    expect(source).toContain("focus_window");
    expect(source).toContain("), 'stale')");
    expect(source).toContain("new BridgeClient(config(false))");
    expect(source).toContain("SetForegroundWindow");
    expect(source).not.toMatch(/notepad|calculator/i);
  });
});
