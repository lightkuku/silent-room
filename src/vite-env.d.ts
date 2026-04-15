/// <reference types="vite/client" />

declare namespace NodeJS {
  interface Timeout {}
  interface Immediate {}
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_WS_URL: string
  readonly VITE_TURNSTILE_SITE_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
