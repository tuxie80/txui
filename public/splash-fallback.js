/* Hard fallback: a wedged app (HMR, a crash before mount) must never
   trap the user on the logo — reveal whatever is there after 5 s. The
   hidden WINDOW itself has the same 5 s net in Rust (lib.rs setup), so
   even a totally dead webview cannot leave a windowless process.
   External file (not inline) so the production CSP can keep
   script-src 'self' with no unsafe-inline. */
setTimeout(function () {
  if (!document.body.classList.contains('txui-ready')) {
    document.body.classList.add('txui-ready');
  }
}, 5000);
