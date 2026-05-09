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
 * The exported `createPlugin(ctx)` factory implements the SDK v2 contract
 * so the agent's plugin loader can drive lifecycle hooks (onServerStart /
 * onServerStop). On start we additionally announce the adapter on the
 * host's `ProviderRegistry` (type: "storage", name: "skalex"). The
 * existing `registerAdapter()` side-effect import below keeps backwards
 * compatibility with the `vibe-plugin-storage` peer registry.
 */

import {
  type HostServices,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";
import { createLifecycleHooks } from "@vibecontrols/plugin-sdk/lifecycle";
import { BoundLogger } from "@vibecontrols/plugin-sdk/log";
import { ProviderRegistry } from "@vibecontrols/plugin-sdk/providers";
import { TelemetryEmitter } from "@vibecontrols/plugin-sdk/telemetry";

// Side-effect: register the "skalex" adapter on import.
import "./skalex.adapter.js";

import { createSkalexAgentDatabase } from "./skalex.adapter.js";

export { createSkalexAgentDatabase } from "./skalex.adapter.js";

const PLUGIN_NAME = "storage-skalex";
const PLUGIN_VERSION = "2026.509.3";

export const createPlugin: VibePluginFactory = (
  ctx: ProfileContext,
): VibePlugin => {
  const log = new BoundLogger(ctx.logger, PLUGIN_NAME);
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "storage-skalex.ready",
    onInit: (hostServices: HostServices) => {
      const providers = new ProviderRegistry(hostServices);
      providers.registerProvider(
        "storage",
        "skalex",
        createSkalexAgentDatabase,
      );
      const telemetry = new TelemetryEmitter(
        PLUGIN_NAME,
        PLUGIN_VERSION,
        hostServices,
      );
      telemetry.emit("storage-skalex.registered", { adapter: "skalex" });
      log.info("skalex storage adapter registered with host ProviderRegistry");
    },
  });

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Skalex encrypted storage adapter (bundled with the agent; registers via side-effect import).",
    tags: ["backend", "adapter", "provider"],
    capabilities: {
      storage: "rw",
      secrets: "read",
    },
    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;
