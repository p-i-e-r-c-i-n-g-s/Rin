/**
 * The locales this site actually ships, i.e. the directories that exist under
 * `client/public/locales`.
 *
 * This is one list on purpose. It feeds two things that must not be allowed to
 * disagree:
 *
 *  - `supportedLngs` in `bootstrap.ts`, which is a **security control**, not a
 *    preference. i18next-http-backend interpolates the detected language into
 *    `loadPath` without encoding it, and `LanguageDetector` reads `?lng=` first,
 *    so an unfiltered language code is attacker-controlled input in a URL
 *    (GHSA-q89c-q3h5-w34g). `supportedLngs` is what stops it reaching the fetch.
 *  - the language menu in `action-buttons.tsx`.
 *
 * Kept together because the failure mode of two lists is silent: adding a
 * locale to the menu alone gives a button that requests a file the allowlist
 * blocks, and adding one to the allowlist alone gives a locale nobody can pick.
 * Neither raises an error.
 *
 * Adding a locale therefore means: create `client/public/locales/<code>/`, then
 * add it here. `locales.test.ts` fails if those two ever drift apart.
 */
export type Locale = {
  /** BCP 47 code, and the directory name under `client/public/locales`. */
  code: string;
  /** Endonym shown in the language menu. */
  name: string;
};

export const LOCALES: readonly Locale[] = [
  { code: "en", name: "English" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "ja", name: "日本語" },
];

/** The allowlist handed to i18next. Order follows `LOCALES`. */
export const SUPPORTED_LNGS: readonly string[] = LOCALES.map(({ code }) => code);
