import type { Settings } from "../shared/ipc";
export function validateTranslationEndpoint(
  config: Pick<Settings, "model" | "endpoint">,
) {
  if (!config.model.trim()) throw Error("Set a translation model in Settings");
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("Use HTTPS, or HTTP on localhost");
}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
  }
}
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
export async function requestJson<T>(
  config: Settings,
  signal: AbortSignal,
  system: string,
  input: unknown,
  validate: (value: unknown) => T,
  schema?: Record<string, unknown>,
): Promise<T> {
  validateTranslationEndpoint(config);
  let correction = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(
        config.endpoint.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey
              ? { Authorization: `Bearer ${config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: config.model,
            // Custom compatible providers use validated JSON prompts by default.
            ...(schema && new URL(config.endpoint).hostname === "api.openai.com"
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: "subtitle_result",
                      strict: true,
                      schema,
                    },
                  },
                }
              : {}),
            messages: [
              { role: "system", content: system + correction },
              { role: "user", content: JSON.stringify(input) },
            ],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
        },
      );
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2) throw error;
      await delay(1000 * 2 ** attempt, signal);
      continue;
    }
    if (!response.ok) {
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        response.status === 408;
      if (!retryable)
        throw new ProviderError(
          `Translation HTTP ${response.status}. Check the endpoint, model, API key and structured-output support.`,
          true,
        );
      if (attempt === 2)
        throw new ProviderError(
          `Translation HTTP ${response.status} after 3 attempts.`,
          false,
        );
      const header = response.headers.get("retry-after");
      const wait = header
        ? /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - Date.now()
        : 1000 * 2 ** attempt;
      await response.body?.cancel();
      await delay(
        Math.min(30000, Math.max(1000, Number.isFinite(wait) ? wait : 1000)),
        signal,
      );
      continue;
    }
    try {
      const body = await response.json();
      signal.throwIfAborted();
      if (body.choices?.[0]?.finish_reason === "length")
        throw Error(
          "The response was truncated; return a complete concise result.",
        );
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim() || text.length > 250000)
        throw Error("Expected a nonempty JSON response under 250 KB.");
      return validate(
        JSON.parse(
          text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2)
        throw Error(
          "Invalid translation response after 3 attempts: " +
            (error as Error).message,
        );
      correction =
        "\nCorrect your response format: " +
        String((error as Error).message).slice(0, 1200);
    }
  }
  throw Error("Translation request did not complete.");
}
