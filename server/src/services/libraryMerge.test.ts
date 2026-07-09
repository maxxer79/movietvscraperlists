import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLibraries,
  type ProviderLibraryInput,
} from "./libraryMerge.js";
import type { MediaItem } from "../scrapers/types.js";

function movie(partial: Partial<MediaItem> & { id: string; title: string }): MediaItem {
  return { type: "movie", ...partial };
}

describe("mergeLibraries", () => {
  it("merges same IMDb id across providers into one card with two retailers", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({
            id: "f1",
            title: "Inception",
            year: 2010,
            posterUrl: "https://example.com/a.jpg",
            quality: "4K UHD",
            meta: { imdbId: "tt1375666" },
          }),
        ],
      },
      {
        providerId: "moviesanywhere",
        providerName: "Movies Anywhere",
        items: [
          movie({
            id: "ma1",
            title: "Inception",
            year: 2010,
            meta: { imdbId: "tt1375666" },
          }),
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "Inception");
    assert.deepEqual(
      merged[0].retailers.map((r) => r.provider).sort(),
      ["fandango", "moviesanywhere"]
    );
    assert.equal(merged[0].posterUrl, "https://example.com/a.jpg");
  });

  it("does not merge movie with tv even if titles match", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({ id: "m1", title: "The Office", year: 2005 }),
          { id: "t1", title: "The Office", type: "tv", year: 2005 },
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 2);
  });

  it("prefers IMDb over title+year when both present", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [
          movie({
            id: "a",
            title: "Wrong Title",
            year: 1999,
            meta: { imdbId: "tt0111161" },
          }),
        ],
      },
      {
        providerId: "appletv",
        providerName: "Apple TV",
        items: [
          movie({
            id: "b",
            title: "The Shawshank Redemption",
            year: 1994,
            meta: { imdbId: "tt0111161" },
          }),
        ],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].retailers.length, 2);
  });

  it("falls back to normalized title+year+type when no external ids", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [movie({ id: "1", title: "Dune", year: 2021, quality: "HDX" })],
      },
      {
        providerId: "primevideo",
        providerName: "Prime Video",
        items: [movie({ id: "2", title: "dune", year: 2021 })],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].retailers.length, 2);
  });

  it("does not merge year-less titles on title-only fallback", () => {
    const inputs: ProviderLibraryInput[] = [
      {
        providerId: "fandango",
        providerName: "Fandango at Home",
        items: [movie({ id: "1", title: "Heat" })],
      },
      {
        providerId: "appletv",
        providerName: "Apple TV",
        items: [movie({ id: "2", title: "Heat" })],
      },
    ];
    const merged = mergeLibraries(inputs);
    assert.equal(merged.length, 2);
  });
});
