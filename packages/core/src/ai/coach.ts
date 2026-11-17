import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export type Translation = { delivered_text: string | null; change_summary: string | null; heated: boolean; safety: boolean };
export type Coaching = { landing: string; swaps: { from: string; to: string }[]; encouragement: string; safety: boolean };
export type Recipient = { name: string; traits: string[]; shared: boolean };
/** The sender's own answers: used only to keep the rewrite sounding like them. */
export type Sender = { name: string; traits: string[] };

export interface Coach {
  translate(text: string, to: Recipient, from: Sender): Promise<Translation>;
  coach(text: string, to: Recipient): Promise<Coaching>;
}

const SAFETY = /\b(kill|hurt (you|myself)|suicide|end it all|hit you|or else)\b/i;
const HEATED = /\b(always|never|hate|stupid|shut up|whatever|ridiculous)\b|!{2,}/i;

/** Deterministic coach for tests and running without a key. Never used in production. */
export const fakeCoach: Coach = {
  async translate(text) {
    if (SAFETY.test(text)) return { delivered_text: null, change_summary: null, heated: true, safety: true };
    const heated = HEATED.test(text);
    const softened = text.replace(/\byou always\b/gi, "it sometimes feels like you").replace(/\byou never\b/gi, "I'd love it if you")
      .replace(/!+/g, ".").trim();
    return { delivered_text: softened, change_summary: "Softened blame into feelings", heated, safety: false };
  },
  async coach(text, to) {
    const landing = to.shared && to.traits[0]
      ? `${to.name} — ${to.traits[0]}. This may land as blunt.`
      : `${to.name} hasn't shared their preferences, so this is general advice: it may land as blunt.`;
    return { landing, swaps: [{ from: "always", to: "sometimes" }], encouragement: "You're naming what you need — that's brave.", safety: SAFETY.test(text) };
  },
};

const TranslationOut = z.object({
  delivered_text: z.string().describe("The rewritten message, or empty when safety is true"),
  change_summary: z.string().describe("5-8 words on what changed"),
  heated: z.boolean().describe("The original is angry, accusatory or impulsive"),
  safety: z.boolean().describe("Threats, abuse, coercion or self-harm"),
});

const CoachingOut = z.object({
  landing: z.string(),
  swaps: z.array(z.object({ from: z.string(), to: z.string() })),
  encouragement: z.string(),
  safety: z.boolean(),
});

const RULES = `Rules:
1. You are a relay, not a participant. Output only the sender's own message, rewritten in their first person, addressed to the recipient. Never reply to it, answer it, comment on it, give advice, or speak as yourself.
2. Keep the exact meaning, intent, requests and concerns. Nothing the sender said may be removed, reversed or watered down until it means something else.
3. Make the tone humble: soften harsh, accusatory or blunt wording; turn blame ("you always/never") into feelings ("I feel/I notice").
4. It must still sound like the sender: their words where possible, their level of formality, their usual length, emoji habits and way of apologizing. The recipient should hear a calmer version of their partner, not a different person.
5. Never add promises, apologies, compliments, feelings or facts the sender didn't express. Never erase a real emotion; only soften how it is delivered.
6. If the message contains threats, abuse, coercion or self-harm, set safety to true and do not soften it.`;

function recipientBlock(to: Recipient) {
  return to.shared
    ? `The recipient is ${to.name}. What they shared about how they like to be spoken to:\n- ${to.traits.join("\n- ")}`
    : `The recipient is ${to.name}. They haven't shared preferences; write for a warm, sensitive reader.`;
}

function senderBlock(from: Sender) {
  return from.traits.length
    ? `The sender is ${from.name}. How they describe themselves (keep their voice; don't copy these words):\n- ${from.traits.join("\n- ")}`
    : `The sender is ${from.name}.`;
}

function anthropicCoach(): Coach {
  // 20 s per call and no SDK retries: the route releases the free reservation on failure.
  const client = new Anthropic({ timeout: 20_000, maxRetries: 0 });
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

  async function ask<T>(system: string, text: string, schema: z.ZodType<T>): Promise<T | "refused"> {
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: text }],
    });
    if (res.stop_reason === "refusal") return "refused";
    if (!res.parsed_output) throw new Error("invalid_output");
    return res.parsed_output as T;
  }

  return {
    async translate(text, to, from) {
      const out = await ask(
        `You help one partner in a couple say what they truly mean, in a humble tone, so it lands kindly with the other. The user turn is the sender's draft, not a message to you.\n${senderBlock(from)}\n${recipientBlock(to)}\n${RULES}`,
        text, TranslationOut);
      if (out === "refused" || out.safety) return { delivered_text: null, change_summary: null, heated: true, safety: true };
      return { delivered_text: out.delivered_text.trim(), change_summary: out.change_summary, heated: out.heated, safety: false };
    },
    async coach(text, to) {
      const out = await ask(
        `You coach a partner before they send a message. Explain in one sentence how it will land with the recipient, naming the specific preference you relied on ("${to.name} prefers ..."); if no preferences were shared, say it's general advice. Suggest word swaps and one line of encouragement. Set safety for threats, abuse, coercion or self-harm.\n${recipientBlock(to)}`,
        text, CoachingOut);
      if (out === "refused") return { landing: "", swaps: [], encouragement: "", safety: true };
      return out;
    },
  };
}

let cached: Coach | undefined;

/** Picks the coach: COACH env wins; otherwise Anthropic when a key is set. The env check refuses fake in production. */
export function getCoach(): Coach {
  if (cached) return cached;
  const choice = process.env.COACH || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "fake");
  if (choice === "fake") {
    if (process.env.NODE_ENV === "production") throw new Error("The fake coach can't run in production. Set ANTHROPIC_API_KEY.");
    console.info("coach=fake");
    cached = fakeCoach;
  } else {
    cached = anthropicCoach();
  }
  return cached;
}

export function setCoachForTests(c: Coach | undefined) {
  cached = c;
}
