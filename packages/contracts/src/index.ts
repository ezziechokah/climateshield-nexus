import { z } from "zod";

export const phoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);
export const registrationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: phoneSchema,
  password: z.string().min(10).max(128),
  language: z.enum(["en", "sw"]).default("en"),
});
const farmFields = {
  name: z.string().trim().min(1).max(100),
  county: z.string().trim().min(1).max(100),
  locality: z.string().trim().min(1).max(100),
  latitude: z.number().min(-4.8).max(5.2).nullable().optional(),
  longitude: z.number().min(33.8).max(42.2).nullable().optional(),
  locationSource: z.enum(["manual", "gps", "assisted"]).default("manual"),
  crop: z.string().trim().min(1).max(80),
  plantingDate: z.string().date().nullable().optional(),
  irrigation: z.enum(["none", "limited", "available", "unknown"]).default("unknown"),
};
export const farmSchema = z.object(farmFields).refine((farm) => (farm.latitude == null) === (farm.longitude == null), {
  message: "Latitude and longitude must be provided together.",
  path: ["longitude"],
});
export const feedbackSchema = z.object({
  assessmentId: z.string().uuid().optional(),
  understandable: z.boolean(),
  useful: z.boolean(),
  actedOn: z.boolean(),
  comment: z.string().max(1000).default(""),
});
export const farmUpdateSchema = z.object({
  name: farmFields.name.optional(),
  county: farmFields.county.optional(),
  locality: farmFields.locality.optional(),
  latitude: farmFields.latitude,
  longitude: farmFields.longitude,
  locationSource: farmFields.locationSource.optional(),
  crop: farmFields.crop.optional(),
  plantingDate: farmFields.plantingDate,
  irrigation: farmFields.irrigation.optional(),
}).refine((farm) =>
  (farm.latitude === undefined && farm.longitude === undefined) ||
  (farm.latitude !== undefined && farm.longitude !== undefined && ((farm.latitude === null) === (farm.longitude === null))), {
    message: "Latitude and longitude must be updated together.",
    path: ["longitude"],
  });
export const notificationConsentSchema = z.object({
  smsConsent: z.boolean(),
  language: z.enum(["en", "sw"]).optional(),
});
export const idempotencyKeySchema = z.string().uuid();
export type RegistrationInput = z.infer<typeof registrationSchema>;
export type FarmInput = z.infer<typeof farmSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;