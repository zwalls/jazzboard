import { z } from "zod";

export const agentMessageIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use a stable message identifier containing only letters, numbers, dots, colons, underscores, or hyphens.");

export const agentMessageStateSchema = z.enum(["pending", "claimed", "answered"]);
export const agentMessageOutcomeSchema = z.enum(["completed", "needs_input", "failed"]);

export const createAgentMessageSchema = z
  .object({
    messageId: agentMessageIdSchema,
    prompt: z.string().trim().min(1).max(10_000),
    selectedObjectIds: z.array(z.string().min(1).max(128)).min(1).max(100),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.selectedObjectIds).size !== input.selectedObjectIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedObjectIds"],
        message: "Selected object IDs must be unique.",
      });
    }
  });

export const claimAgentMessageSchema = z
  .object({
    claimId: agentMessageIdSchema,
    leaseSeconds: z.number().int().min(15).max(900),
  })
  .strict();

export const replyAgentMessageSchema = z
  .object({
    replyId: agentMessageIdSchema,
    claimToken: z.string().min(32).max(256),
    text: z.string().trim().min(1).max(20_000),
    outcome: agentMessageOutcomeSchema,
  })
  .strict();

export const agentMessageListQuerySchema = z
  .object({
    status: agentMessageStateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    afterSequence: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.afterSequence !== undefined && input.status !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["afterSequence"],
        message:
          "A sequence cursor lists newly created messages across all states. Omit status, or omit the cursor when polling an actionable state.",
      });
    }
  });

export type AgentMessageListQuery = z.infer<typeof agentMessageListQuerySchema>;
