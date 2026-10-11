import { HumanMessage } from "@langchain/core/messages";
import { MessagesPlaceholder } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import {
  AGENT_PROMPT,
  AGENT_SYSTEM,
  CUSTOMER_SERVICE_PROMPT,
  EXTRACT_PROMPT,
} from "#/core/prompts.ts";
import { contentText } from "#tests/helpers/json.ts";

describe("prompt templates", () => {
  it("renders the customer-service prompt with history", async () => {
    const msgs = await CUSTOMER_SERVICE_PROMPT.formatMessages({
      history: [new HumanMessage("Do you sell cat food?")],
    });
    expect(msgs[0]?.type).toBe("system");
    expect(contentText(msgs.at(-1)?.content)).toBe("Do you sell cat food?");
    const system = contentText(msgs[0]?.content);
    for (const keyword of ["Yukino", "Never fabricate", "order"]) {
      expect(system).toContain(keyword);
    }
  });

  it("renders the extract prompt with the raw text", async () => {
    const msgs = await EXTRACT_PROMPT.formatMessages({
      text: "Order MH1 is broken, I want a refund",
    });
    expect(msgs[0]?.type).toBe("system");
    expect(contentText(msgs.at(-1)?.content)).toContain(
      "Order MH1 is broken, I want a refund",
    );
  });

  it("agent system covers the tool-use principles", () => {
    for (const kw of [
      "Yukino",
      "query_faq",
      "create_ticket",
      "never fabricate",
    ]) {
      expect(AGENT_SYSTEM.toLowerCase()).toContain(kw.toLowerCase());
    }
  });

  it("agent prompt keeps the history placeholder", () => {
    const hasHistory = AGENT_PROMPT.promptMessages.some(
      (m) => m instanceof MessagesPlaceholder && m.variableName === "history",
    );
    expect(hasHistory).toBe(true);
  });
});
