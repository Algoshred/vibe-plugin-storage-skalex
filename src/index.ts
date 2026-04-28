/**
 * @vibecontrols/vibe-plugin-storage-skalex
 *
 * Skalex storage provider for the VibeControls agent.
 * Document-oriented, file-backed, encrypted at rest via AES-256-GCM.
 *
 * Importing this module registers the adapter under the name "skalex"
 * with @vibecontrols/vibe-plugin-storage.
 */

// Side-effect: register the "skalex" adapter on import.
import "./skalex.adapter.js";

export { createSkalexAgentDatabase } from "./skalex.adapter.js";
