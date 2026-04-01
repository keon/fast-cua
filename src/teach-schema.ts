import { z } from "zod";

function optionalNonEmptyString() {
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }
    return value;
  }, z.string().min(1).optional());
}

export const teachComponentSchema = z
  .object({
    name: z.string().min(1),
    role: z.string().min(1),
    locationHint: z.string().min(1),
    state: optionalNonEmptyString(),
  })
  .strict();

export const teachAnnotationSchema = z
  .object({
    summary: z.string().min(1),
    visibleApp: optionalNonEmptyString(),
    userGoalGuess: optionalNonEmptyString(),
    notableChange: optionalNonEmptyString(),
    importantComponents: z.array(teachComponentSchema).max(3),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const teachAnnotationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    visibleApp: { type: "string" },
    userGoalGuess: { type: "string" },
    notableChange: { type: "string" },
    importantComponents: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          locationHint: { type: "string" },
          state: { type: "string" },
        },
        required: ["name", "role", "locationHint"],
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["summary", "importantComponents", "confidence"],
} as const;
