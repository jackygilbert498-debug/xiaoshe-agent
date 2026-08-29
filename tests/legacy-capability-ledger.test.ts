import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVED_CLASSIFICATIONS,
  buildInventory,
  discoverLegacyPublicSurface,
  validateInventory,
} from "../scripts/audit-legacy-capabilities.mjs";

describe("legacy capability ledger", () => {
  it("covers every registered tool and public CLI surface with a valid decision", async () => {
    const root = resolve(".");
    const discovered = await discoverLegacyPublicSurface(root);
    const inventory = await buildInventory(root);
    const errors = validateInventory(discovered, inventory);

    expect(discovered.tools.length).toBeGreaterThan(30);
    expect(discovered.cli.length).toBeGreaterThan(8);
    expect(errors).toEqual([]);
    expect(new Set(inventory.capabilities.map(item => item.classification)).size).toBeGreaterThan(3);
    for (const capability of inventory.capabilities) {
      expect(APPROVED_CLASSIFICATIONS).toContain(capability.classification);
    }

    const markdown = await readFile(resolve("docs/LEGACY_CAPABILITY_LEDGER.md"), "utf8");
    expect(markdown).toContain("旧能力迁移账本");
    expect(markdown).toContain("应迁移");
    expect(markdown).toContain("不迁移第二套 Agent Runtime");
  });
});
