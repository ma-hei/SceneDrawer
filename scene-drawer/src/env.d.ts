interface ImportMetaEnv {
  /** The object server's address, e.g. "https://objects.example.com". Empty: same address as the page. */
  readonly VITE_OBJECT_SERVER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
