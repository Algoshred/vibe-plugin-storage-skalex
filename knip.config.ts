import { knipConfig } from "@burdenoff/toolchain/knip/base";

export default knipConfig({
  entry: ["src/index.ts"],
  project: ["src/**/*.ts", "tests/**/*.ts"],
  // The plugin contract exports the factory both as `createPlugin` and as the
  // default export (the agent loads either), so duplicate exports are intended.
  rules: { duplicates: "off" },
});
