/*
 * Body + signature for the iPhone Shortcut.
 *
 * Paste this into the Actions app's "Transform Text with JavaScript" action.
 * That action runs JavaScriptCore and exposes the input as a global `$text`;
 * the value of the last statement becomes the action's output.
 *
 * WHY THIS EXISTS AT ALL
 * Shortcuts has no HMAC action, and its JSON serializer is not something you
 * can inspect or pin. Since /api/ingest signs the literal request body, the
 * body and its signature have to be produced by the same piece of code, from
 * the same string, in one step. Building the JSON in Shortcuts and signing it
 * here would leave two serializers to disagree, which is the failure this
 * whole arrangement is designed to remove.
 *
 * INPUT  three lines: sender, ISO-8601 received_at, then the message body.
 *        The body is everything after the second newline, so its own line
 *        breaks — every bank message has several — need no escaping.
 *
 * OUTPUT three lines: signature, unix timestamp, JSON body.
 *        The JSON is single-line because JSON.stringify escapes newlines,
 *        so "Split Text by New Lines" always yields exactly three items.
 *
 * Verified byte-for-byte against the Python server in
 * tests/verify_shortcut_signer.py. Change either side and run it.
 */

// Same value as INGEST_SECRET on Vercel. Use the Actions app's "Keychain"
// action to fetch it at runtime rather than leaving it in the shortcut body,
// where it is readable by anyone who opens the shortcut or receives a copy.
var SECRET = "PASTE_INGEST_SECRET_HERE";
var DEVICE_ID = "iphone";

// --- HMAC-SHA256, no dependencies -----------------------------------------
// JavaScriptCore has no crypto.subtle and no TextEncoder, so both SHA-256 and
// UTF-8 encoding are done by hand. UTF-8 matters more than it looks: the
// bodies are Arabic, so almost every byte signed here is multi-byte, and an
// encoder that disagreed with Python's would fail only on real messages.

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
               0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

function sha256Bytes(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  var msg = bytes.slice();
  var bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // Length is 64-bit big-endian. The high word is computed with division
  // rather than shifts because >>> is 32-bit and would silently drop it.
  var hi = Math.floor(bitLen / 4294967296);
  msg.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  var lo = bitLen >>> 0;
  msg.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

  var w = new Array(64);
  for (var off = 0; off < msg.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) |
             (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  var out = [];
  for (i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255,
             (h[i] >>> 8) & 255, h[i] & 255);
  }
  return out;
}

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function hmacSha256Hex(keyStr, msgStr) {
  var key = utf8Bytes(keyStr);
  if (key.length > 64) key = sha256Bytes(key);
  while (key.length < 64) key.push(0);

  var inner = [], outer = [];
  for (var i = 0; i < 64; i++) {
    inner.push(key[i] ^ 0x36);
    outer.push(key[i] ^ 0x5c);
  }
  var digest = sha256Bytes(outer.concat(
    sha256Bytes(inner.concat(utf8Bytes(msgStr)))));

  var hex = "";
  for (i = 0; i < digest.length; i++) {
    hex += (digest[i] < 16 ? "0" : "") + digest[i].toString(16);
  }
  return hex;
}

// --- build and sign --------------------------------------------------------

function buildRequest(text, secret, deviceId, nowSeconds) {
  var nl1 = text.indexOf("\n");
  var rest = text.slice(nl1 + 1);
  var nl2 = rest.indexOf("\n");

  var sender = text.slice(0, nl1).trim();
  var receivedAt = rest.slice(0, nl2).trim();
  var body = rest.slice(nl2 + 1);

  // Key order is irrelevant to the server now that it verifies the bytes it
  // received, but stay stable anyway: a signature that changes when nothing
  // changed makes every future comparison against the Python side useless.
  var payload = JSON.stringify({
    sender: sender,
    body: body,
    received_at: receivedAt,
    device_id: deviceId,
  });

  return hmacSha256Hex(secret, payload) + "\n" + nowSeconds + "\n" + payload;
}

// Exported for the verification harness; ignored by JavaScriptCore, which has
// no `module`. Keep this guarded or the action throws a ReferenceError.
if (typeof module !== "undefined") {
  module.exports = { buildRequest: buildRequest, hmacSha256Hex: hmacSha256Hex };
}

// The action's output is the value of the last statement. The typeof guard is
// what lets the verification harness require this same file under Node, where
// there is no $text — testing a copy of the code would defeat the point.
// If Actions ever reports "Unexpected token" here, wrap it in `return`.
typeof $text === "undefined"
  ? ""
  : buildRequest($text, SECRET, DEVICE_ID, Math.floor(Date.now() / 1000));
