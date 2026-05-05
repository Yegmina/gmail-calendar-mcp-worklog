import type { Context } from "telegraf";

export type DownloadedImage = {
  data: string;
  mimeType: string;
  description: string;
};

export async function downloadTelegramImage(ctx: Context, fileId: string, mimeType = "image/jpeg"): Promise<DownloadedImage> {
  const link = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(link);
  if (!response.ok) {
    throw new Error(`Telegram image download failed: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return {
    data,
    mimeType,
    description: `${mimeType} from Telegram file ${fileId}`,
  };
}

export function imageCaption(caption: string | undefined): string {
  return caption?.trim() || "Please analyze the attached image and act on it if the instruction is clear.";
}
