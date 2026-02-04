import { z } from "zod";

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  admins: z.array(z.number()).optional().describe("List of admin QQ numbers"),
  requireMention: z.boolean().optional().default(false).describe("Require @mention or reply to bot in group chats"),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;
