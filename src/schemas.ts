import { z } from "zod";

/**
 * Runtime schema for a successfully parsed railway delay notice.
 * The API validates parser output against this schema before returning it,
 * so an invalid parse can never be returned as a successful (HTTP 200) result.
 */
export const ParsedNoticeSchema = z
  .object({
    trainNumber: z
      .string()
      .regex(/^\d{5}$/, "trainNumber must be exactly 5 digits")
      .refine((v) => parseInt(v, 10) > 0, "trainNumber must be greater than zero"),
    stationCode: z
      .string()
      .regex(/^[A-Z]{2,5}$/, "stationCode must be 2-5 uppercase letters"),
    expectedTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expectedTime must be a 24-hour HH:MM time"),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ParsedNotice = {
  trainNumber: string;
  stationCode: string;
  expectedTime: string;
  reason?: string;
};

/**
 * Runtime schema for the HTTP request body accepted by every parse route.
 * Strict mode rejects unexpected keys, so client-supplied fields such as
 * "price" or "payTo" can never influence server behaviour.
 */
export function buildNoticeRequestBodySchema(noticeMaxLength = 4096) {
  return z
    .object({
      notice: z
        .string({
          required_error: "notice is required",
          invalid_type_error: "notice must be a string",
        })
        .min(1, "notice must not be empty")
        .max(noticeMaxLength, `notice must not exceed ${noticeMaxLength} characters`),
    })
    .strict();
}

export const NoticeRequestBodySchema = buildNoticeRequestBodySchema();

export type NoticeRequestBody = z.infer<typeof NoticeRequestBodySchema>;
