import { Iso8601 } from "@openconditions/model";
import { z } from "zod";
/** JMAXML 1.3 transport and native semantics, distinct from InfoKindVersion. */
export const JmaDetails = z.strictObject({
  messageUrl: z.url(),
  family: z.enum(["VXSE51", "VXSE52", "VXSE53", "VPWW55", "VPWW56", "VPWW57", "VFVO50"]),
  controlAt: Iso8601,
  reportAt: Iso8601,
  targetAt: Iso8601.optional(),
  validAt: Iso8601.optional(),
  eventId: z.string(),
  serial: z.string(),
  infoType: z.enum(["発表", "訂正", "取消"]),
  infoKindVersion: z.string().min(1),
  publishingOffice: z.string().min(1),
  editorialOffice: z.string().min(1),
  nativeXml: z.string().min(1),
  contributingReports: z
    .array(
      z.strictObject({
        family: z.enum(["VXSE51", "VXSE52", "VXSE53"]),
        messageUrl: z.url(),
        controlAt: Iso8601,
        nativeXml: z.string().min(1),
      }),
    )
    .max(3)
    .optional(),
  areaSystem: z.string().min(1).optional(),
  areaCode: z.string().min(1).optional(),
  warningCode: z.string().min(1).optional(),
  warningWording: z.string().min(1).optional(),
  warningStatus: z.string().optional(),
  intensity: z.enum(["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7", "不明"]).optional(),
  shakingAreas: z
    .array(
      z.strictObject({
        system: z.enum([
          "地震情報／都道府県等",
          "地震情報／細分区域",
          "気象・地震・火山情報／市町村等",
          "震度観測点",
        ]),
        code: z.string().min(1),
        name: z.string().min(1),
        maxIntensity: z
          .enum(["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7", "不明"])
          .optional(),
        intensity: z
          .enum(["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7", "不明"])
          .optional(),
      }),
    )
    .max(10000)
    .optional(),
  coordinateRaw: z.string().optional(),
  coordinateDescription: z.string().optional(),
  magnitudeDescription: z.string().optional(),
});
