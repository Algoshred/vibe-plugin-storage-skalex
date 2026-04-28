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

## License

Proprietary — Burdenoff Consultancy Services Pvt. Ltd.
