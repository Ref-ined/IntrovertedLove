import { z } from "zod";
import { ApiError } from "./errors.ts";
import QUESTIONS from "./questions.json" with { type: "json" };

export type Question = { id: string; text: string; multiple?: boolean; options: { value: string; label: string }[] };
export const questions = QUESTIONS as Question[];

export const answersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

/** Validates every answer against its option list and derives readable traits for the AI. */
export function deriveTraits(answers: z.infer<typeof answersSchema>): string[] {
  const traits: string[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined) throw new ApiError(400, "invalid_input", `Question ${q.id} is unanswered.`, { fields: [{ path: q.id, message: "required" }] });
    const values = Array.isArray(a) ? a : [a];
    if ((!q.multiple && Array.isArray(a)) || values.length === 0) {
      throw new ApiError(400, "invalid_input", `Question ${q.id} needs ${q.multiple ? "at least one" : "exactly one"} answer.`, { fields: [{ path: q.id, message: "wrong shape" }] });
    }
    const labels = values.map((v) => {
      const opt = q.options.find((o) => o.value === v);
      if (!opt) throw new ApiError(400, "invalid_input", `"${v}" isn't an option for ${q.id}.`, { fields: [{ path: q.id, message: "unknown option" }] });
      return opt.label;
    });
    traits.push(`${q.text} → ${labels.join("; ")}`);
  }
  const extra = Object.keys(answers).filter((k) => !questions.some((q) => q.id === k));
  if (extra.length) throw new ApiError(400, "invalid_input", `Unknown questions: ${extra.join(", ")}.`);
  return traits;
}

export const NEUTRAL_TRAITS = ["No preferences shared: be warm, clear and gentle."];

type Answers = Record<string, unknown>;
const one = (a: Answers, id: string) => (typeof a[id] === "string" ? (a[id] as string) : undefined);
const label = (id: string, v: string) => questions.find((q) => q.id === id)?.options.find((o) => o.value === v)?.label;

// Ported from v1 (app/backend/services/ai_service.py): how a recipient's answers shape the rewrite.
const SENSITIVITY: Record<string, string> = {
  high: "very sensitive to tone — the way something is said matters deeply", medium: "moderately sensitive to tone",
  low: "not particularly sensitive to tone", minimal: "rarely affected by tone, focuses on content",
};
const REASSURANCE: Record<string, string> = {
  high: "needs frequent reassurance and validation", medium: "appreciates occasional reassurance",
  low: "needs little reassurance", minimal: "very independent, needs minimal reassurance",
};
const FEEDBACK: Record<string, string> = {
  direct: "prefers direct, honest feedback even if hard to hear", gentle: "needs gentle, encouraging feedback with care",
  examples: "understands better with specific examples", process_first: "needs time to process — avoid pressure for immediate reaction",
};
const LOVE_LANGUAGE: Record<string, string> = {
  words: "values words of affirmation and verbal love", acts: "feels loved through acts of service",
  time: "values quality time and undivided attention", touch: "feels loved through physical closeness", gifts: "appreciates thoughtful gestures",
};

/** The recipient's profile, as v1 described it to the AI. */
export function recipientProfile(a: Answers): string[] {
  const out = [
    `Sensitivity: ${SENSITIVITY[one(a, "q5") ?? ""] ?? SENSITIVITY.medium}`,
    `Reassurance needs: ${REASSURANCE[one(a, "q6") ?? ""] ?? REASSURANCE.medium}`,
    `Feedback preference: ${FEEDBACK[one(a, "q3") ?? ""] ?? FEEDBACK.gentle}`,
    `Love language: ${LOVE_LANGUAGE[one(a, "q7") ?? ""] ?? LOVE_LANGUAGE.words}`,
  ];
  const topics = (Array.isArray(a.q9) ? (a.q9 as string[]) : []).map((v) => label("q9", v) ?? v);
  if (topics.length) out.push(`Be especially gentle about: ${topics.join(", ")}.`);
  if (one(a, "q12") === "anxious") out.push("Avoid leaving ambiguous endings — always close with warmth or reassurance.");
  if (one(a, "q18") === "listen") out.push("When the sender is sharing feelings, don't add advice or solutions — focus on validation.");
  if (one(a, "q17") === "go_quiet") out.push("Respect their need for space; don't pressure for immediate responses.");
  if (one(a, "q14") === "frequent") out.push("Brief, warm check-in messages resonate well with them.");
  return out;
}

/** How the sender writes, so the rewrite still sounds like them. */
export function senderVoice(a: Answers): string[] {
  const parts: [string, string][] = [
    ["q1", "Says what bothers them"], ["q4", "Emoji use"], ["q8", "Message length"],
    ["q11", "Apologizes"], ["q15", "Humor under tension"], ["q16", "Shows affection in texts"],
  ];
  return parts.flatMap(([id, name]) => {
    const l = label(id, one(a, id) ?? "");
    return l ? [`${name}: ${l}`] : [];
  });
}
