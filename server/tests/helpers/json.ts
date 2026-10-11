import type { z } from "zod";

/** Parse a Response body with zod — no type assertions needed in tests. */
export async function readJson<T extends z.ZodType>(
  res: Response,
  schema: T,
): Promise<z.infer<T>> {
  return schema.parse(await res.json());
}

/** Stringify message content without tripping no-base-to-string. */
export function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}
