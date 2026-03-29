import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig, Provider } from "./types.js";

export const CONFIG_PATH = path.join(os.homedir(), ".ctx-switch.json");
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".cc-continue.json");

export function loadConfig(configPath: string = CONFIG_PATH): AppConfig {
  // Try new config first, fall back to legacy
  for (const candidate of [configPath, LEGACY_CONFIG_PATH]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as AppConfig;
    } catch {
      // try next
    }
  }
  return {};
}

export function saveConfig(config: AppConfig, configPath: string = CONFIG_PATH): void {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best effort. Some filesystems do not support chmod.
  }
}

function getProviderConfig(config: AppConfig, provider: Provider) {
  return config.providers?.[provider] || {};
}

export function getApiKey({
  provider,
  cliValue,
  env = process.env,
  config = loadConfig(),
}: {
  provider: Provider;
  cliValue: string | null;
  env?: NodeJS.ProcessEnv;
  config?: AppConfig;
}): string | null {
  if (cliValue) return cliValue;

  if (provider === "openrouter" && env.OPENROUTER_API_KEY) {
    return env.OPENROUTER_API_KEY;
  }

  const providerConfig = getProviderConfig(config, provider);
  return providerConfig.apiKey || config.openrouter_api_key || null;
}

export function getDefaultModel({
  provider,
  cliValue,
  config = loadConfig(),
}: {
  provider: Provider;
  cliValue: string | null;
  config?: AppConfig;
}): string {
  if (cliValue) return cliValue;

  const providerConfig = getProviderConfig(config, provider);
  return providerConfig.model || "openrouter/free";
}

export function storeApiKey({
  provider,
  apiKey,
  configPath = CONFIG_PATH,
}: {
  provider: Provider;
  apiKey: string;
  configPath?: string;
}): void {
  const config = loadConfig(configPath);
  config.providers = config.providers || {};
  config.providers[provider] = config.providers[provider] || {};
  config.providers[provider].apiKey = apiKey;

  if (provider === "openrouter") {
    delete config.openrouter_api_key;
  }

  saveConfig(config, configPath);
}

export function promptForApiKey({
  provider,
  input = process.stdin,
  output = process.stderr,
}: {
  provider: Provider;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<string | null> {
  if (!input.isTTY || !output.isTTY) {
    return Promise.resolve(null);
  }

  const label = provider === "openrouter" ? "OpenRouter" : provider;
  const prompt = `Enter your ${label} API key: `;

  return new Promise((resolve, reject) => {
    let buffer = "";
    const previousRawMode = input.isRaw;

    function cleanup(): void {
      input.removeListener("data", onData);
      if (input.isTTY) {
        input.setRawMode(Boolean(previousRawMode));
      }
      input.pause();
    }

    function finish(value: string): void {
      cleanup();
      output.write("\n");
      resolve(value.trim() || null);
    }

    function onData(chunk: string | Buffer): void {
      const text = chunk.toString("utf8");

      if (text === "\u0003") {
        cleanup();
        output.write("\n");
        const error = new Error("Prompt cancelled") as Error & { exitCode?: number };
        error.exitCode = 130;
        reject(error);
        return;
      }

      if (text === "\r" || text === "\n") {
        finish(buffer);
        return;
      }

      if (text === "\u007f") {
        buffer = buffer.slice(0, -1);
        return;
      }

      if (text.startsWith("\u001b")) {
        return;
      }

      buffer += text;
    }

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
