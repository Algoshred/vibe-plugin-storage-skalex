# @vibecontrols/vibe-plugin-storage-skalex

Skalex storage provider for the VibeControls agent.

Document-oriented, file-backed, encrypted at rest via AES-256-GCM. Zero native dependencies — runs natively on Bun.

## Usage

Importing this package registers the adapter under the name `"skalex"` with `@vibecontrols/vibe-plugin-storage`. The agent picks it up automatically:

```ts
import "@vibecontrols/vibe-plugin-storage-skalex"; // registers "skalex"
import { createAgentDatabase } from "@vibecontrols/vibe-plugin-storage";

const db = await createAgentDatabase({
  dbPath: "/path/to/data",
  encryptionKey: "f".repeat(64), // 32 bytes hex
});
```

## Encryption

All on-disk data is AES-256-GCM encrypted via Skalex's built-in `encrypt: { key }` option. Each collection is gzipped + ciphertext on disk.

The end-to-end test (`scripts/e2e-encryption.sh`) bootstraps the full chain and grep-asserts the absence of plaintext on disk.

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
