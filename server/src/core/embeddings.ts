import OpenAI from "openai";

import { embeddingsEnabled, settings } from "#/config.ts";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client === null) {
    client = new OpenAI({
      baseURL: settings.embedBaseUrl,
      apiKey: settings.embedApiKey,
    });
  }
  return client;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!embeddingsEnabled()) {
    throw new Error(
      "EMBED_API_KEY is not configured; embedding-backed jobs (kb-vectorize/kb-repatch) are unavailable",
    );
  }
  const resp = await getClient().embeddings.create({
    model: settings.embedModel,
    input: texts,
  });
  return resp.data.map((d) => d.embedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0];
}
