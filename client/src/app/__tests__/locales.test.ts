import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import i18n from "i18next";
import { LOCALES, SUPPORTED_LNGS } from "../locales";

const LOCALES_DIR = resolve(import.meta.dir, "../../../public/locales");

/**
 * Ask i18next which languages it will actually request from the backend for a
 * given detected code. The backend stub records instead of fetching, so this
 * observes the real resolution path rather than asserting on the config.
 */
async function languagesRequestedFor(
  lng: string,
  options: Record<string, unknown> = {},
) {
  const requested: string[] = [];
  const recordingBackend = {
    type: "backend" as const,
    init() {},
    read(language: string, _ns: string, callback: (e: unknown, d: unknown) => void) {
      requested.push(language);
      callback(null, {});
    },
  };

  await i18n
    .createInstance()
    .use(recordingBackend as never)
    .init({
      lng,
      ns: ["translation"],
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      ...options,
    });

  return requested;
}

describe("LOCALES", () => {
  it("lists exactly the locale directories that exist on disk", () => {
    const onDisk = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect([...SUPPORTED_LNGS].sort()).toEqual(onDisk);
  });

  it("gives every locale a display name", () => {
    for (const { code, name } of LOCALES) {
      expect(name.trim().length).toBeGreaterThan(0);
      expect(code.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("supportedLngs keeps an untrusted language code out of the request URL", () => {
  // i18next-http-backend interpolates {{lng}} into loadPath without encoding
  // it, and LanguageDetector reads ?lng= first, so the detected code is
  // attacker-controlled input in a URL (GHSA-q89c-q3h5-w34g).
  const TRAVERSAL = "../..";

  it("CONTROL: without the allowlist, the traversing code does reach the backend", async () => {
    // Guards the test below. If i18next ever stops asking for an unknown code
    // at all, the real assertion would pass for the wrong reason and stop
    // testing anything.
    const requested = await languagesRequestedFor(TRAVERSAL);
    expect(requested).toContain(TRAVERSAL);
  });

  it("blocks the traversing code when the allowlist is applied", async () => {
    const requested = await languagesRequestedFor(TRAVERSAL, {
      supportedLngs: [...SUPPORTED_LNGS],
    });

    expect(requested.some((language) => language.includes(".."))).toBe(false);
    expect(requested).toEqual(["en"]);
  });

  it("still loads every locale the site ships", async () => {
    for (const code of SUPPORTED_LNGS) {
      const requested = await languagesRequestedFor(code, {
        supportedLngs: [...SUPPORTED_LNGS],
      });
      expect(requested).toContain(code);
    }
  });

  it("collapses a regional variant onto its base language", async () => {
    // en-US / ja-JP have no files of their own; before the allowlist they were
    // each requested and 404'd on the way to the base language.
    for (const [variant, base] of [
      ["en-US", "en"],
      ["ja-JP", "ja"],
    ]) {
      const requested = await languagesRequestedFor(variant, {
        supportedLngs: [...SUPPORTED_LNGS],
      });
      expect(requested).toContain(base);
      expect(requested).not.toContain(variant);
    }
  });
});
