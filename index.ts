import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { qqChannel } from "./src/channel.js";
import { setQQRuntime } from "./src/runtime.js";

const plugin = {
  id: "qq",
  name: "QQ (OneBot)",
  description: "QQ channel plugin via OneBot v11",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQRuntime(api.runtime);
    api.registerChannel({ plugin: qqChannel });
  },
};

export default plugin;
