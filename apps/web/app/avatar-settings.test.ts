import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AVATARS, avatarSettings, isImageAvatar } from "./avatar-settings.ts";

test("normalizes saved avatar settings and falls back to defaults", () => {
  assert.deepEqual(avatarSettings({ humanAvatar: "👩", agentAvatar: "🛠️" }), { humanAvatar: "👩", agentAvatar: "🛠️" });
  assert.deepEqual(avatarSettings({ humanAvatar: "", agentAvatar: null }), DEFAULT_AVATARS);
  assert.deepEqual(avatarSettings(null), DEFAULT_AVATARS);
});

test("recognizes only supported embedded avatar image formats", () => {
  assert.equal(isImageAvatar("data:image/png;base64,AA=="), true);
  assert.equal(isImageAvatar("data:image/webp;base64,AA=="), true);
  assert.equal(isImageAvatar("data:image/svg+xml;base64,AA=="), false);
  assert.equal(isImageAvatar("https://example.com/avatar.png"), false);
});
