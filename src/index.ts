/**
 * @vibecontrols/vibe-plugin-storage-skalex
 *
 * Skalex storage provider for the VibeControls agent.
 * Document-oriented, file-backed, encrypted at rest via AES-256-GCM.
 *
 * Importing this module registers the adapter under the name "skalex"
 * with @vibecontrols/vibe-plugin-storage. The agent statically imports
 * this package at startup — it is NOT meant to be installed at runtime
 * via the plugin manager.
 *
 * The `vibePlugin` manifest below is a no-op stub kept for defensive
 * compatibility: if some operator does run `vibe plugin install
 * @vibecontrols/vibe-plugin-storage-skalex`, the agent's plugin loader
 * will accept it (the side-effect import already registered the adapter
 * on the first load when the agent booted).
 */

// Side-effect: register the "skalex" adapter on import.
import "./skalex.adapter.js";

export { createSkalexAgentDatabase } from "./skalex.adapter.js";

interface PluginCapabilities {
  storage?: "none" | "read" | "rw";
  secrets?: "none" | "read" | "rw";
  gateway?: boolean;
  broadcast?: boolean;
  subprocess?: boolean;
  audit?: boolean;
  telemetry?: boolean;
}

interface MinimalVibePlugin {
  capabilities?: PluginCapabilities;
  name: string;
  version: string;
  description?: string;
  tags?: ("backend" | "frontend" | "cli" | "provider" | "adapter" | "integration")[];
}

export const vibePlugin: MinimalVibePlugin = {
  capabilities: {
    storage: "rw",
    secrets: "read",
  },
  name: "storage-skalex",
  version: "1.0.0",
  description:
    "Skalex encrypted storage adapter (bundled with the agent; registers via side-effect import).",
  tags: ["backend", "adapter", "provider"],
};
