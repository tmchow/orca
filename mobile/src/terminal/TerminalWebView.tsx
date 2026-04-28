import { useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'

export type TerminalWebViewHandle = {
  write: (data: string) => void
  init: (cols: number, rows: number) => void
  clear: () => void
}

type Props = object

type TerminalMessage =
  | { type: 'write'; data: string }
  | { type: 'init'; cols: number; rows: number }
  | { type: 'clear' }

// Why: TUI apps (Claude Code / Ink) emit escape codes with absolute cursor
// positioning designed for the desktop's terminal dimensions (~150 cols).
// Rendering at phone-native dimensions (55 cols) garbles TUI output because
// row/col coordinates don't match. Instead, we initialize xterm at the
// desktop's exact cols/rows and use CSS transform: scale() to shrink the
// canvas to fit the phone viewport. This produces an accurate miniature of
// the desktop screen. Pinch-to-zoom is enabled for readability.
const XTERM_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=0.5, maximum-scale=5, user-scalable=yes">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.1.0-beta.198/css/xterm.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: #1a1b26;
    -webkit-overflow-scrolling: touch;
  }
  #terminal-container {
    transform-origin: top left;
    overflow: visible;
  }
</style>
</head>
<body>
<div id="terminal-container"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.1.0-beta.198/lib/xterm.min.js"></script>
<script>
(function() {
  var FONT_SIZE = 13;

  var container = document.getElementById('terminal-container');
  var term = null;
  var writeQueue = [];
  var ready = false;
  var currentScale = 1;

  function applyScale() {
    if (!term) return;
    var screen = container.querySelector('.xterm-screen');
    if (!screen) return;
    var termWidth = screen.offsetWidth;
    var viewWidth = window.innerWidth;
    if (termWidth > viewWidth) {
      currentScale = viewWidth / termWidth;
      container.style.transform = 'scale(' + currentScale + ')';
      container.style.width = (100 / currentScale) + '%';
    } else {
      currentScale = 1;
      container.style.transform = 'none';
      container.style.width = '100%';
    }
  }

  function init(cols, rows) {
    ready = false;
    writeQueue = [];
    if (term) term.dispose();
    container.style.transform = 'none';
    container.style.width = '100%';
    term = new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
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
      fontSize: FONT_SIZE,
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      convertEol: false,
      allowProposedApi: true
    });
    term.open(container);
    requestAnimationFrame(function() {
      applyScale();
      ready = true;
      for (var i = 0; i < writeQueue.length; i++) {
        term.write(writeQueue[i]);
      }
      writeQueue = [];
      notify({ type: 'ready' });
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

  function handleMsg(msg) {
    if (msg.type === 'init') {
      init(msg.cols, msg.rows);
    } else if (msg.type === 'write') {
      write(msg.data);
    } else if (msg.type === 'clear') {
      writeQueue = [];
      if (term) { term.clear(); term.reset(); }
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
        // Why: React Native drops postMessage calls made before the WebView page
        // has installed its message handlers, so terminal output must wait here.
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
        }
      }),
      [postMessage]
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
        showsVerticalScrollIndicator={false}
        setBuiltInZoomControls={false}
        scalesPageToFit={false}
        androidLayerType="none"
        onLoadStart={handleLoadStart}
        onMessage={handleMessage}
      />
    )
  }
)

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: '#1a1b26'
  }
})
