#!/usr/bin/env node
/* Regenerates everything in icons/.
 *
 *   npm run icons
 *
 * Written against Node's own zlib rather than an image library, because the
 * rest of this project installs nothing and an icon script is a poor reason to
 * start. A PNG is a signature, three chunks and a CRC.
 *
 * The mark is the panel itself: the thick rule under the calorie line is the
 * single most recognisable thing about a Nutrition Facts label, so the icon is
 * that rule with the rows above and below it, in the app's own colours.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var OUT = path.join(__dirname, '..', 'icons');

var BG = [11, 15, 20];          // --bg
var PANEL = [232, 238, 246];    // --ink, the label's white
var RULE = [17, 22, 29];        // the heavy bars
var ACCENT = [53, 192, 122];    // --low, the one line that carries the answer

/* ---------- PNG ---------- */

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// RGB, 8 bits per channel, no interlacing. Every scanline is prefixed with
// filter type 0 ("none") — deflate does the compressing and a flat colour
// field costs almost nothing either way.
function encodePng(width, height, rgb) {
  var raw = Buffer.alloc(height * (1 + width * 3));
  var o = 0;
  for (var y = 0; y < height; y++) {
    raw[o++] = 0;
    for (var x = 0; x < width; x++) {
      var i = (y * width + x) * 3;
      raw[o++] = rgb[i];
      raw[o++] = rgb[i + 1];
      raw[o++] = rgb[i + 2];
    }
  }

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- drawing ---------- */

function canvas(size, color) {
  var rgb = Buffer.alloc(size * size * 3);
  for (var i = 0; i < size * size; i++) {
    rgb[i * 3] = color[0];
    rgb[i * 3 + 1] = color[1];
    rgb[i * 3 + 2] = color[2];
  }
  return rgb;
}

function rect(rgb, size, x0, y0, w, h, color, radius) {
  var r = radius || 0;
  var x1 = x0 + w, y1 = y0 + h;
  for (var y = Math.max(0, Math.floor(y0)); y < Math.min(size, Math.ceil(y1)); y++) {
    for (var x = Math.max(0, Math.floor(x0)); x < Math.min(size, Math.ceil(x1)); x++) {
      if (r > 0 && !insideRounded(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) continue;
      var i = (y * size + x) * 3;
      rgb[i] = color[0];
      rgb[i + 1] = color[1];
      rgb[i + 2] = color[2];
    }
  }
}

// Only the corners need testing: everywhere else the point is trivially in.
function insideRounded(px, py, x0, y0, x1, y1, r) {
  var cx = px < x0 + r ? x0 + r : (px > x1 - r ? x1 - r : px);
  var cy = py < y0 + r ? y0 + r : (py > y1 - r ? y1 - r : py);
  if (cx === px && cy === py) return true;
  var dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/* The mark. `inset` is the share of the tile left empty around it — a maskable
 * icon is cropped to a circle by the launcher, so its artwork has to sit well
 * inside the square or the corners of the panel are shaved off. */
function draw(size, inset) {
  var rgb = canvas(size, BG);
  var pad = Math.round(size * inset);
  var w = size - pad * 2;
  var panelH = Math.round(w * 1.02);
  var top = Math.round((size - panelH) / 2);

  // The label itself.
  rect(rgb, size, pad, top, w, panelH, PANEL, Math.round(w * 0.09));

  var m = Math.round(w * 0.12);              // margin inside the panel
  var innerW = w - m * 2;
  var y = top + Math.round(panelH * 0.13);

  // "Nutrition Facts" — a heavy title bar, then the serving line.
  rect(rgb, size, pad + m, y, innerW, Math.round(panelH * 0.105), RULE);
  y += Math.round(panelH * 0.155);
  rect(rgb, size, pad + m, y, Math.round(innerW * 0.62), Math.round(panelH * 0.035), RULE);

  // The thick rule above the calorie line — the one bar everybody recognises.
  y += Math.round(panelH * 0.085);
  rect(rgb, size, pad + m, y, innerW, Math.round(panelH * 0.055), RULE);

  // The calorie line, in the accent colour, because that number is the reason
  // this app exists.
  y += Math.round(panelH * 0.105);
  rect(rgb, size, pad + m, y, Math.round(innerW * 0.72), Math.round(panelH * 0.14), ACCENT);

  // The rows below it, tapering the way a real panel's do.
  y += Math.round(panelH * 0.205);
  rect(rgb, size, pad + m, y, innerW, Math.round(panelH * 0.03), RULE);
  [0.86, 0.7, 0.78].forEach(function (frac) {
    y += Math.round(panelH * 0.075);
    rect(rgb, size, pad + m, y, Math.round(innerW * frac), Math.round(panelH * 0.035), RULE);
  });

  return encodePng(size, size, rgb);
}

/* ---------- write ---------- */

fs.mkdirSync(OUT, { recursive: true });

var files = [
  ['icon-192.png', draw(192, 0.08)],
  ['icon-512.png', draw(512, 0.08)],
  // A maskable icon is cropped to whatever shape the launcher likes, and only
  // the middle 80% is guaranteed to survive it.
  ['maskable-512.png', draw(512, 0.19)],
  ['apple-touch-icon.png', draw(180, 0.08)]
];

files.forEach(function (f) {
  fs.writeFileSync(path.join(OUT, f[0]), f[1]);
  console.log('wrote icons/' + f[0] + '  (' + f[1].length + ' bytes)');
});
