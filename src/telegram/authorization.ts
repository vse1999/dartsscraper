export function parseAllowedUserId(rawUserId: string | undefined): number {
  if (rawUserId === undefined || !/^\d+$/u.test(rawUserId)) {
    throw new Error("ALLOWED_USER_ID must be a positive numeric Telegram user ID.");
  }

  const userId = Number(rawUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("ALLOWED_USER_ID must be a positive safe integer.");
  }
  return userId;
}

export function isOwnerPrivateChat(
  fromUserId: number | undefined,
  chatType: string | undefined,
  allowedUserId: number,
): boolean {
  return fromUserId === allowedUserId
    && chatType === "private";
}
