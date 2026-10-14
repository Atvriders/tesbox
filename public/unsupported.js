/*
 * Tesbox Unsupported fallback (spec §6.5, §10.2 item 1). Classic ES5 script — no let/const,
 * arrows or template literals: it must run in the MCU1 QtCarBrowser, which has no ES modules.
 *
 * index.html loads it twice: `<script nomodule>` (only browsers without ES modules run it) and
 * `<script defer>` (every browser). When ES modules, AudioContext or AudioWorkletNode are missing it
 * reveals the static #unsupported block with the reason and hides #app. src/main.ts makes the same
 * check before it boots, so the two never disagree. CSP-clean: external file, no style attributes.
 * The reason texts equal STR.unsupported in src/ui/strings.ts (tests/unit/unsupported-js.test.ts).
 */
(function (win, doc) {
  'use strict';

  var reason = null;
  if (!('noModule' in doc.createElement('script'))) {
    reason = 'This browser cannot load ES modules.';
  } else if (!win.AudioContext) {
    reason = 'This browser has no Web Audio AudioContext.';
  } else if (!win.AudioWorkletNode) {
    reason = 'This browser has no Web Audio AudioWorklet (it also needs a secure https:// page).';
  }
  if (reason === null) return;

  var box = doc.getElementById('unsupported');
  if (box) {
    box.hidden = false;
    box.removeAttribute('hidden');
  }
  var out = doc.getElementById('unsupported-reason');
  if (out) out.textContent = reason;
  var app = doc.getElementById('app');
  if (app) app.hidden = true;
})(window, document);
