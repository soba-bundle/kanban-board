import { z } from "zod";

export const LiveEventSchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()),
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;
