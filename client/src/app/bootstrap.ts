import i18n from "i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { listenSystemMode } from "../utils/darkModeUtils";
import { SUPPORTED_LNGS } from "./locales";

let bootstrapped = false;

export function bootstrapApp() {
  if (bootstrapped) {
    return;
  }

  listenSystemMode();

  i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      backend: {
        loadPath: "/locales/{{lng}}/{{ns}}.json",
      },
      // Load-bearing, and not a preference. `loadPath` interpolates {{lng}}
      // without encoding it, and LanguageDetector's default order reads
      // `?lng=` FIRST, so without this list `?lng=../..` escapes /locales/ and
      // the app fetches translations from an arbitrary same-origin path
      // (GHSA-q89c-q3h5-w34g). supportedLngs is what keeps an unknown code
      // from ever reaching the request. See ./locales.ts.
      supportedLngs: [...SUPPORTED_LNGS],
      fallbackLng: "en",
      interpolation: {
        escapeValue: false,
      },
    });

  bootstrapped = true;
}
