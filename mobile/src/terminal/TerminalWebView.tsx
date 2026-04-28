import { useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import { colors } from '../theme/mobile-theme'

export type TerminalWebViewHandle = {
  write: (data: string) => void
  init: (cols: number, rows: number) => void
  clear: () => void
  measureFitDimensions: () => Promise<{ cols: number; rows: number } | null>
  resetZoom: () => void
}

type Props = object

type TerminalMessage =
  | { type: 'write'; data: string }
  | { type: 'init'; cols: number; rows: number }
  | { type: 'clear' }
  | { type: 'measure' }
  | { type: 'reset-zoom' }

// Why: TUI apps (Claude Code / Ink) emit escape codes with absolute cursor
// positioning designed for the desktop's terminal dimensions (~150+ cols).
// We initialize xterm at the desktop's exact cols/rows so those escape codes
// render correctly, then use a measured CSS transform: scale() to fit the
// canvas into the phone viewport. The scale is computed after xterm opens
// by measuring the rendered surface width, not hardcoded, so it adapts to
// any terminal column count (80, 150, 200+). The WebView's native
// pinch-to-zoom provides user-controlled zoom on top of the initial fit.
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: ${colors.terminalBg};
    overflow: auto;
    width: 100%;
    height: 100%;
  }
  #scroll-container {
    overflow: auto;
    width: 100%;
    height: 100%;
  }
  #terminal-surface {
    transform-origin: top left;
    display: inline-block;
  }
</style>
</head>
<body>
<div id="scroll-container">
  <div id="terminal-surface"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script>
(function() {
  var surface = document.getElementById('terminal-surface');
  var scrollContainer = document.getElementById('scroll-container');
  var term = null;
  var writeQueue = [];
  var ready = false;
  var currentScale = 1;

  function computeFitScale() {
    if (!term) return 1;
    var el = term.element;
    if (!el) return 1;
    var termWidth = el.scrollWidth;
    var vpWidth = window.innerWidth;
    if (termWidth <= 0) return 1;
    return Math.min(1, vpWidth / termWidth);
  }

  function applyFitScale() {
    if (!term || !term.element) return;
    currentScale = computeFitScale();
    surface.style.transform = 'scale(' + currentScale + ')';
    var el = term.element;
    scrollContainer.style.width = Math.ceil(el.scrollWidth * currentScale) + 'px';
    scrollContainer.style.height = Math.ceil(el.scrollHeight * currentScale) + 'px';
  }

  function init(cols, rows) {
    ready = false;
    writeQueue = [];
    if (term) term.dispose();

    term = new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      theme: {
        background: '${colors.terminalBg}',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '${colors.terminalBg}',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5'
      },
      fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      convertEol: false,
      allowProposedApi: true
    });
    term.open(surface);

    requestAnimationFrame(function() {
      ready = true;
      for (var i = 0; i < writeQueue.length; i++) {
        term.write(writeQueue[i]);
      }
      writeQueue = [];
      applyFitScale();
      window.scrollTo(0, 0);
      notify({ type: 'ready', cols: cols, rows: rows });
    });
  }

  function write(data) {
    if (ready && term) {
      term.write(data);
    } else {
      writeQueue.push(data);
    }
  }

  function notify(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  function measureFitDimensions() {
    if (!term || !term.element) {
      notify({ type: 'measure-result', cols: null, rows: null });
      return;
    }
    // Why: measure actual xterm cell dimensions from the renderer, not from
    // font metrics alone. This accounts for the exact font, size, and line
    // height that xterm is using.
    var core = term._core;
    var cellWidth = 0;
    var cellHeight = 0;
    if (core && core._renderService && core._renderService.dimensions) {
      cellWidth = core._renderService.dimensions.css.cell.width;
      cellHeight = core._renderService.dimensions.css.cell.height;
    }
    if (cellWidth <= 0 || cellHeight <= 0) {
      notify({ type: 'measure-result', cols: null, rows: null });
      return;
    }
    var vpWidth = window.innerWidth;
    var vpHeight = window.innerHeight;
    var cols = Math.floor(vpWidth / cellWidth);
    var rows = Math.floor(vpHeight / cellHeight);
    notify({ type: 'measure-result', cols: cols, rows: rows });
  }

  function handleMsg(msg) {
    if (msg.type === 'init') {
      init(msg.cols, msg.rows);
    } else if (msg.type === 'write') {
      write(msg.data);
    } else if (msg.type === 'clear') {
      writeQueue = [];
      if (term) { term.clear(); term.reset(); }
    } else if (msg.type === 'measure') {
      measureFitDimensions();
    } else if (msg.type === 'reset-zoom') {
      applyFitScale();
      window.scrollTo(0, 0);
    }
  }

  window.addEventListener('message', function(e) {
    try {
      handleMsg(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    } catch(ex) {}
  });

  document.addEventListener('message', function(e) {
    try {
      handleMsg(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
    } catch(ex) {}
  });

  window.addEventListener('resize', function() {
    applyFitScale();
  });

  if (window.Terminal) {
    notify({ type: 'web-ready' });
  } else {
    notify({ type: 'error', message: 'xterm failed to load' });
  }
})();
</script>
</body>
</html>`

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(
  function TerminalWebView(_props, ref) {
    const webViewRef = useRef<WebView>(null)
    const isWebReadyRef = useRef(false)
    const pendingMessagesRef = useRef<TerminalMessage[]>([])
    const measureResolveRef = useRef<
      ((result: { cols: number; rows: number } | null) => void) | null
    >(null)

    const sendToWebView = useCallback((msg: TerminalMessage) => {
      webViewRef.current?.postMessage(JSON.stringify(msg))
    }, [])

    const flushPendingMessages = useCallback(() => {
      const pending = pendingMessagesRef.current
      pendingMessagesRef.current = []
      for (const msg of pending) {
        sendToWebView(msg)
      }
    }, [sendToWebView])

    const postMessage = useCallback(
      (msg: TerminalMessage) => {
        if (!isWebReadyRef.current) {
          pendingMessagesRef.current.push(msg)
          return
        }
        sendToWebView(msg)
      },
      [sendToWebView]
    )

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
        } catch {
          return
        }

        if (msg.type === 'web-ready') {
          isWebReadyRef.current = true
          flushPendingMessages()
        } else if (msg.type === 'measure-result') {
          const resolve = measureResolveRef.current
          measureResolveRef.current = null
          if (resolve) {
            const cols = typeof msg.cols === 'number' ? msg.cols : null
            const rows = typeof msg.rows === 'number' ? msg.rows : null
            resolve(cols && rows && cols >= 20 && rows >= 8 ? { cols, rows } : null)
          }
        }
      },
      [flushPendingMessages]
    )

    const handleLoadStart = useCallback(() => {
      isWebReadyRef.current = false
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        write(data: string) {
          postMessage({ type: 'write', data })
        },
        init(cols: number, rows: number) {
          postMessage({ type: 'init', cols, rows })
        },
        clear() {
          postMessage({ type: 'clear' })
        },
        measureFitDimensions(): Promise<{ cols: number; rows: number } | null> {
          if (!isWebReadyRef.current) return Promise.resolve(null)
          return new Promise((resolve) => {
            measureResolveRef.current = resolve
            sendToWebView({ type: 'measure' })
            // Why: if the WebView doesn't respond within 2s (e.g., xterm
            // failed to load), resolve null so the caller can disable
            // Fit to Phone rather than hanging indefinitely.
            setTimeout(() => {
              if (measureResolveRef.current === resolve) {
                measureResolveRef.current = null
                resolve(null)
              }
            }, 2000)
          })
        },
        resetZoom() {
          postMessage({ type: 'reset-zoom' })
        }
      }),
      [postMessage, sendToWebView]
    )

    return (
      <WebView
        ref={webViewRef}
        source={{ html: XTERM_HTML }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled
        nestedScrollEnabled
        scalesPageToFit={false}
        onLoadStart={handleLoadStart}
        onMessage={handleMessage}
      />
    )
  }
)

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  }
})
