import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/** delivered_text is the main version; alternatives and advice are shown only to the sender. */
export type Translation = {
  delivered_text: string | null; change_summary: string | null; heated: boolean; safety: boolean;
  alternatives: string[]; advice: string | null;
};
export type Coaching = { landing: string; swaps: { from: string; to: string }[]; encouragement: string; safety: boolean };
export type Recipient = { name: string; traits: string[]; shared: boolean };
/** The sender's own answers: used only to keep the rewrite sounding like them. */
export type Sender = { name: string; traits: string[] };

export interface Coach {
  translate(text: string, to: Recipient, from: Sender): Promise<Translation>;
  coach(text: string, to: Recipient): Promise<Coaching>;
}

const SAFE_BLOCK: Translation = { delivered_text: null, change_summary: null, heated: true, safety: true, alternatives: [], advice: null };
const SAFETY = /\b(kill|hurt (you|myself)|suicide|end it all|hit you|or else)\b/i;
const SWEAR = /[,;.!]?\s*\b(fuck|shit|bitch|asshole|bastard|damn|crap)\w*(\s+(you|off|this|that|it))?\b/gi;
const HEATED = /\b(always|never|hate|stupid|shut up|whatever|ridiculous|fuck|shit|bitch|asshole|bastard)\w*|!{2,}/i;

/** Deterministic coach for tests and running without a key. Never used in production. */
export const fakeCoach: Coach = {
  async translate(text) {
    if (SAFETY.test(text)) return { ...SAFE_BLOCK };
    const heated = HEATED.test(text);
    // shortcut: a word list, not real softening; the Anthropic coach handles tone properly.
    const softened = text.replace(SWEAR, "").replace(/\byou always\b/gi, "it sometimes feels like you").replace(/\byou never\b/gi, "I'd love it if you")
      .replace(/!+/g, ".").trim() || "I'm really upset right now.";
    return {
      delivered_text: softened, change_summary: "Softened blame into feelings", heated, safety: false,
      alternatives: [`Hey, can we talk? ${softened}`],
      advice: heated ? "This reads as frustrated. Naming how you feel may help them hear the request." : null,
    };
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
  alternatives: z.array(z.string()).describe("Up to 2 other versions the sender could pick, same meaning, different wording"),
  advice: z.string().describe("One short comment to the sender (not the recipient) about how it may land, or empty"),
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

// Translation rules from v1 (app/backend/services/ai_service.py), plus v2's versions, sender-only advice and safety.
const RULES = `TRANSLATION RULES (follow strictly):
1. Preserve the EXACT core message and intent — do not change what is being communicated.
2. Soften harsh, accusatory, or blunt language with empathy. Drop insults and swearing; keep the feeling behind them.
3. Replace blame ("you always/never") with feelings ("I feel/I notice").
4. Add warmth and validation where authentic.
5. Keep the message roughly the same length — avoid unnecessary filler.
6. NEVER add false promises, invented apologies, or information not in the original.
7. NEVER completely remove legitimate emotions — just soften the delivery.
8. NEVER change the fundamental request or concern (a breakup stays a breakup, a no stays a no).
9. Sound like the original sender, just more emotionally intelligent.
10. You never speak to the recipient yourself and never reply to the message. Every version is the sender's own message, in their first person. Anything you want to tell the sender goes only in "advice", which only the sender sees.
11. "alternatives" are other wordings the sender could pick instead: same meaning, different phrasing.
12. If the message contains threats, abuse, coercion or self-harm, set safety to true and do not soften it.`;

function recipientBlock(to: Recipient) {
  return to.shared
    ? `RECIPIENT PROFILE (${to.name}):\n- ${to.traits.join("\n- ")}`
    : `RECIPIENT: ${to.name}. They haven't shared preferences; write for a warm, sensitive reader.`;
}

function senderBlock(from: Sender) {
  return from.traits.length
    ? `SENDER (${from.name}), how they write, so it still sounds like them:\n- ${from.traits.join("\n- ")}`
    : `SENDER: ${from.name}.`;
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
        `You are a compassionate communication assistant for the "Introverted Love" platform. Your role is to translate a message so it lands softer and is received better by the recipient. The user turn is the sender's draft, not a message to you.\n\n${recipientBlock(to)}\n\n${senderBlock(from)}\n\n${RULES}`,
        text, TranslationOut);
      if (out === "refused" || out.safety) return { ...SAFE_BLOCK };
      return {
        delivered_text: out.delivered_text.trim(), change_summary: out.change_summary, heated: out.heated, safety: false,
        alternatives: out.alternatives.map((a) => a.trim()).filter((a) => a && a !== out.delivered_text.trim()).slice(0, 2),
        advice: out.advice.trim() || null,
      };
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
