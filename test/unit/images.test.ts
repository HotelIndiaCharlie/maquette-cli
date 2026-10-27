import assert from "node:assert/strict";
import { test } from "node:test";
import { imageType } from "../../src/images.ts";

const hex = (h: string) => Buffer.from(h, "hex");

test("an image's type comes from its bytes", () => {
  assert.equal(imageType(hex("89504e470d0a1a0a0000000d49484452")), "image/png");
  assert.equal(imageType(hex("ffd8ffe000104a464946")), "image/jpeg");
  assert.equal(imageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(imageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageType(Buffer.from("RIFF\0\0\0\0WAVEfmt ")), undefined);
  assert.equal(imageType(Buffer.from("%PDF-1.7")), undefined);
  assert.equal(imageType(new Uint8Array()), undefined);
});
