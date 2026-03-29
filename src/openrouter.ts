import https from "node:https";
import type { IncomingMessage } from "node:http";
import type {
  OpenRouterErrorDetails,
  OpenRouterPayload,
  OpenRouterRefinementResult,
} from "./types.js";

interface OpenRouterApiResponse {
  error?: {
    message?: string;
  };
  message?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export function buildOpenRouterPayload({
  model,
  systemPrompt,
  userPrompt,
}: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): OpenRouterPayload {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
}

function parseJsonSafely(value: string): OpenRouterApiResponse | null {
  try {
    return JSON.parse(value) as OpenRouterApiResponse;
  } catch {
    return null;
  }
}

export function classifyOpenRouterError({
  statusCode,
  body = "",
  requestError,
}: {
  statusCode?: number;
  body?: string;
  requestError?: string;
}): OpenRouterErrorDetails {
  if (requestError) {
    return {
      category: "network",
      message: requestError,
      suggestions: [
        "Check your network connection and try again.",
        "Run `ctx-switch --raw` if you want to skip refinement.",
      ],
    };
  }

  const parsed = parseJsonSafely(body);
  const providerMessage =
    parsed?.error?.message || parsed?.message || (body ? String(body).slice(0, 500) : "Unknown provider error");
  const lower = providerMessage.toLowerCase();

  if (statusCode === 404 && lower.includes("guardrail restrictions") && lower.includes("data policy")) {
    return {
      category: "privacy-policy",
      message:
        "OpenRouter blocked this model because your privacy settings do not allow any available endpoint for it.",
      suggestions: [
        "Open https://openrouter.ai/settings/privacy and relax the privacy restriction for this model.",
        "Retry with `ctx-switch --raw` if you want to skip provider refinement.",
        "Retry with `ctx-switch --model <another-openrouter-model>` if you have another allowed model.",
      ],
      raw: providerMessage,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      category: "auth",
      message: "OpenRouter rejected the request. Check that your API key is valid and allowed to use this model.",
      suggestions: [
        "Verify `OPENROUTER_API_KEY` or rerun interactively to save a fresh key.",
        "Retry with `ctx-switch --raw` if you want to skip refinement.",
      ],
      raw: providerMessage,
    };
  }

  if (statusCode === 404) {
    return {
      category: "not-found",
      message: "OpenRouter could not find a compatible endpoint for this request.",
      suggestions: [
        "Retry with `ctx-switch --model <another-openrouter-model>`.",
        "Run `ctx-switch --raw` if you want to skip provider refinement.",
      ],
      raw: providerMessage,
    };
  }

  if (statusCode === 429) {
    return {
      category: "rate-limit",
      message: "OpenRouter rate limited this request.",
      suggestions: [
        "Wait a bit and retry.",
        "Run `ctx-switch --raw` if you want to skip refinement.",
      ],
      raw: providerMessage,
    };
  }

  return {
    category: "provider",
    message: statusCode ? `OpenRouter error ${statusCode}: ${providerMessage}` : providerMessage,
    suggestions: ["Retry with `ctx-switch --raw` if you want to skip refinement."],
    raw: providerMessage,
  };
}

interface StreamChunkChoice {
  delta?: { content?: string };
}

interface StreamChunk {
  choices?: StreamChunkChoice[];
  error?: { message?: string };
}

function parseSSEChunk(line: string): string | null {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as StreamChunk;
    if (parsed.error) return null;
    return parsed.choices?.[0]?.delta?.content || null;
  } catch {
    return null;
  }
}

function doStreamRequest({
  apiKey,
  body,
  timeoutMs,
  onStatus,
  onToken,
}: {
  apiKey: string;
  body: string;
  timeoutMs: number;
  onStatus?: (status: string) => void;
  onToken?: (token: string) => void;
}): Promise<OpenRouterRefinementResult> {

  return new Promise((resolve) => {
    let receivedFirstToken = false;
    let fullText = "";
    let sseBuffer = "";

    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res: IncomingMessage) => {
        onStatus?.(`provider responded (${res.statusCode || "unknown"})`);

        // Non-streaming error response
        if (res.statusCode && res.statusCode >= 400) {
          let errorData = "";
          res.on("data", (chunk: Buffer | string) => { errorData += chunk; });
          res.on("end", () => {
            const classified = classifyOpenRouterError({ statusCode: res.statusCode!, body: errorData });
            resolve({
              ok: false,
              error: classified.message,
              category: classified.category,
              suggestions: classified.suggestions,
              rawError: classified.raw || errorData.slice(0, 500),
            });
          });
          return;
        }

        res.on("data", (chunk: Buffer | string) => {
          sseBuffer += chunk;
          const lines = sseBuffer.split("\n");
          // Keep the last partial line in the buffer
          sseBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const token = parseSSEChunk(trimmed);
            if (token) {
              if (!receivedFirstToken) {
                receivedFirstToken = true;
                onStatus?.("streaming");
              }
              fullText += token;
              onToken?.(token);
            }
          }
        });

        res.on("end", () => {
          // Process any remaining buffer
          if (sseBuffer.trim()) {
            const token = parseSSEChunk(sseBuffer.trim());
            if (token) {
              fullText += token;
              onToken?.(token);
            }
          }

          if (fullText) {
            resolve({ ok: true, text: fullText });
          } else {
            // Might be a non-streamed error in a 200 response
            resolve({ ok: false, error: "Empty response from provider" });
          }
        });
      }
    );

    onStatus?.("sending request");

    req.on("socket", () => {
      onStatus?.("waiting for provider");
    });

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        onStatus?.("request timed out");
        req.destroy(new Error("Provider request timed out"));
      });
    }

    req.on("error", (error: Error) => {
      const classified = classifyOpenRouterError({ requestError: error.message });
      resolve({
        ok: false,
        error: classified.message,
        category: classified.category,
        suggestions: classified.suggestions,
        rawError: error.message,
      });
    });

    req.write(body);
    req.end();
  });
}

export async function refineWithOpenRouter({
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  timeoutMs = 0,
  onStatus,
  onToken,
}: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  onStatus?: (status: string) => void;
  onToken?: (token: string) => void;
}): Promise<OpenRouterRefinementResult> {
  const payload = buildOpenRouterPayload({ model, systemPrompt, userPrompt });

  // Try with low reasoning effort first (faster)
  const fastBody = JSON.stringify({ ...payload, stream: true, reasoning: { effort: "low" } });
  const firstResult = await doStreamRequest({ apiKey, body: fastBody, timeoutMs, onStatus, onToken });

  // If the model rejected reasoning:none, retry without it
  if (!firstResult.ok && firstResult.rawError && /reasoning/i.test(firstResult.rawError)) {
    onStatus?.("retrying without reasoning flag");
    const fallbackBody = JSON.stringify({ ...payload, stream: true });
    return doStreamRequest({ apiKey, body: fallbackBody, timeoutMs, onStatus, onToken });
  }

  return firstResult;
}
