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
