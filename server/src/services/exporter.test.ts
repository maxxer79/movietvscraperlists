import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toMergedCsv } from "./exporter.js";

describe("toMergedCsv", () => {
  it("includes Retailers column", () => {
    const csv = toMergedCsv([
      {
        id: "x",
        title: "Dune",
        type: "movie",
        year: 2021,
        quality: "4K UHD",
        retailers: [
          { provider: "fandango", providerName: "Fandango at Home", itemId: "1" },
          { provider: "moviesanywhere", providerName: "Movies Anywhere", itemId: "2" },
        ],
        provider: "fandango",
        providerName: "Fandango at Home",
      },
    ]);
    assert.match(csv, /Retailers/);
    assert.match(csv, /Fandango at Home; Movies Anywhere/);
  });
});
