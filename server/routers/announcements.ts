import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";

const announcementInput = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(60000),
  type: z.enum(["normal", "popup"]).default("normal"),
});

function sanitizeAnnouncementContent(content: string) {
  return content
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/\s(?:href|src)=["']\s*javascript:[^"']*["']/gi, "");
}

export const announcementsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listUserAnnouncements();
  }),

  popup: protectedProcedure.query(async ({ ctx }) => {
    return db.getUnreadPopupAnnouncement(ctx.user.id);
  }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await db.dismissAnnouncement(ctx.user.id, input.id);
      return { success: true };
    }),

  create: adminProcedure
    .input(announcementInput)
    .mutation(async ({ input, ctx }) => {
      const result = await db.createAnnouncement({
        title: input.title,
        content: sanitizeAnnouncementContent(input.content),
        type: input.type,
        isActive: true,
        startsAt: null,
        expiresAt: null,
        createdByUserId: ctx.user.id,
      } as any);
      appendPanelLog("info", `[Announcement] created type=${input.type} user=${ctx.user.id}`);
      return result;
    }),

  update: adminProcedure
    .input(announcementInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const result = await db.updateAnnouncement(input.id, {
        title: input.title,
        content: sanitizeAnnouncementContent(input.content),
        type: input.type,
        isActive: true,
        startsAt: null,
        expiresAt: null,
      } as any);
      appendPanelLog("info", `[Announcement] updated id=${input.id}`);
      return result;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.deleteAnnouncement(input.id);
      appendPanelLog("info", `[Announcement] deleted id=${input.id}`);
      return { success: true };
    }),
});
