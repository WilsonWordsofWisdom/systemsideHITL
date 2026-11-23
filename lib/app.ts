import { loadConfig, type AppConfig } from "./config";

let cached: AppConfig | undefined;

// Validated configuration, loaded once per server instance (control S7).
export function appConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
