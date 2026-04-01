import { z } from "zod";

const coordinateSchema = z.tuple([z.number(), z.number()]);

const toolInputSchema = z
  .object({
    coordinate: coordinateSchema.optional(),
    start_coordinate: coordinateSchema.optional(),
    text: z.string().optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().positive().optional(),
    duration: z.number().positive().optional(),
    display_id: z.union([z.number().int(), z.literal("auto")]).optional(),
  })
  .strict();

export const agentDecisionSchema = z
  .object({
    tool: z.enum([
      "wait",
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "mouse_move",
      "left_click_drag",
      "scroll",
      "type",
      "key",
      "switch_display",
    ]),
    input: toolInputSchema,
    description: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const requiresCoordinate = [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "mouse_move",
    ];

    if (requiresCoordinate.includes(value.tool) && !value.input.coordinate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "This tool requires `input.coordinate`.",
        path: ["input", "coordinate"],
      });
    }

    if (value.tool === "left_click_drag") {
      if (!value.input.start_coordinate || !value.input.coordinate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`left_click_drag` requires `start_coordinate` and `coordinate`.",
          path: ["input"],
        });
      }
    }

    if (value.tool === "scroll") {
      if (!value.input.direction || typeof value.input.amount !== "number") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`scroll` requires `direction` and `amount`.",
          path: ["input"],
        });
      }
    }

    if (value.tool === "type" && !value.input.text) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`type` requires `text`.",
        path: ["input", "text"],
      });
    }

    if (value.tool === "key" && !value.input.text) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`key` requires `text`.",
        path: ["input", "text"],
      });
    }

    if (value.tool === "switch_display" && value.input.display_id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`switch_display` requires `display_id`.",
        path: ["input", "display_id"],
      });
    }
  });

export const agentDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: {
      type: "string",
      enum: [
        "wait",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "mouse_move",
        "left_click_drag",
        "scroll",
        "type",
        "key",
        "switch_display",
      ],
    },
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
        text: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
        duration: { type: "number" },
        display_id: {
          anyOf: [{ type: "number" }, { type: "string", enum: ["auto"] }],
        },
      },
      required: [],
    },
    description: { type: "string" },
  },
  required: ["tool", "input", "description"],
} as const;
