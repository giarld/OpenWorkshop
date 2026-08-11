export type AvatarSettings = { humanAvatar: string; agentAvatar: string };

export const DEFAULT_AVATARS: AvatarSettings = { humanAvatar: "🙂", agentAvatar: "🤖" };
export const AVATAR_SETTINGS_EVENT = "workshop:avatar-settings";

export function avatarSettings(value: unknown): AvatarSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_AVATARS;
  const settings = value as Record<string, unknown>;
  return {
    humanAvatar: typeof settings.humanAvatar === "string" && settings.humanAvatar ? settings.humanAvatar : DEFAULT_AVATARS.humanAvatar,
    agentAvatar: typeof settings.agentAvatar === "string" && settings.agentAvatar ? settings.agentAvatar : DEFAULT_AVATARS.agentAvatar
  };
}

export function isImageAvatar(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value);
}
