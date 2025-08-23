import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type AnimName =
  | 'Bark' | 'Bite' | 'Blink' | 'Death' | 'IdleBlink'
  | 'Run' | 'Sniff' | 'Tracking' | 'Walk';

type AnimMap = Record<AnimName, string[]>;

type AnimConfig = {
  intervalMs: number;
  loop: boolean;
};

// Configuration interface
interface DogConfig {
  size: number;
  idleTimeout: number;
  enableBark: boolean;
  barkDelay: number;
  deathCooldown: number;
  position: { x: number; y: number };
}

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let animations: AnimMap | null = null;

  // Configuration
  let config: DogConfig = {
    size: 120,
    idleTimeout: 10000,
    enableBark: true,
    barkDelay: 5000,
    deathCooldown: 5000,
    position: { x: 16, y: 16 }
  };

  // typing/idle & temp states
  let lastTypeTime = Date.now();
  let tempHoldUntil = 0;
  let deathLocked = false;
  let typingActive = false;
  let diagBarkTimeout: ReturnType<typeof setTimeout> | null = null;
  let currentAnim: AnimName | null = null;
  let successRunTimeout: ReturnType<typeof setTimeout> | null = null;
  let quickIdleTimeout: ReturnType<typeof setTimeout> | null = null;

  // Enhanced timings - more responsive
  const IDLE_THRESHOLD_MS = 300;           // Reduced from 800ms
  const SUCCESS_RUN_DURATION_MS = 10000;

  // More nuanced idle behavior
  let idleBlinkCount = 0;
  const MAX_IDLE_BLINKS = 3;

  const animConfig: Record<AnimName, AnimConfig> = {
    Bark:       { intervalMs: 100, loop: true },
    Bite:       { intervalMs: 80, loop: false },
    Blink:      { intervalMs: 110, loop: false },
    Death:      { intervalMs: 160, loop: false },
    IdleBlink:  { intervalMs: 130, loop: true },
    Run:        { intervalMs: 90, loop: true },
    Sniff:      { intervalMs: 100, loop: true },
    Tracking:   { intervalMs: 100, loop: true },
    Walk:       { intervalMs: 100, loop: true },
  };

  let nextBarkAllowedAt = 0;

  // Load user configuration
  function loadConfig() {
    const vsConfig = vscode.workspace.getConfiguration('codedog');
    config.size = vsConfig.get('size', 120);
    config.idleTimeout = vsConfig.get('idleTimeout', 10000);
    config.enableBark = vsConfig.get('enableBark', true);
    config.barkDelay = vsConfig.get('barkDelay', 5000);
    config.deathCooldown = vsConfig.get('deathCooldown', 5000);
    
    const savedPos = context.globalState.get<{x: number, y: number}>('dogPosition');
    if (savedPos) {
      config.position = savedPos;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.start', () => {
      loadConfig();
      if (!panel) {
        panel = vscode.window.createWebviewPanel(
          'codedog',
          'Code Dog 🐶',
          vscode.ViewColumn.Two,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
          }
        );
        
        panel.webview.onDidReceiveMessage(message => {
          if (message.type === 'positionUpdate') {
            config.position = { x: message.x, y: message.y };
            context.globalState.update('dogPosition', config.position);
          }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
          panel = undefined;
          if (diagBarkTimeout) {
            clearTimeout(diagBarkTimeout);
            diagBarkTimeout = null;
          }
          if (successRunTimeout) {
            clearTimeout(successRunTimeout);
            successRunTimeout = null;
          }
          if (quickIdleTimeout) {
            clearTimeout(quickIdleTimeout);
            quickIdleTimeout = null;
          }
        }, null, context.subscriptions);

        panel.webview.html = initialHtml();
        animations = loadAllAnimations(context, panel);
        setAnimation('IdleBlink');

        wireEvents();
      } else {
        panel.reveal(vscode.ViewColumn.Two);
      }
    })
  );

  // Test commands
  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.testRun', () => {
      if (panel && animations && !deathLocked) {
        setAnimation('Run');
        setTimeout(() => {
          if (!deathLocked && !isTempActive()) applyBaseline();
        }, 3000);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.testBite', () => {
      if (panel && animations && !deathLocked) {
        playTemp('Bite', 800);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.resetPosition', () => {
      config.position = { x: 16, y: 16 };
      context.globalState.update('dogPosition', config.position);
      if (panel) {
        panel.webview.postMessage({ 
          type: 'updatePosition', 
          x: config.position.x, 
          y: config.position.y 
        });
      }
      vscode.window.showInformationMessage('Dog position reset to bottom-right corner');
    })
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codedog')) {
        loadConfig();
        if (panel) {
          panel.webview.postMessage({ 
            type: 'updateConfig', 
            size: config.size,
            position: config.position
          });
        }
      }
    })
  );

  // Listen for regular Run button (F5)
  context.subscriptions.push(
    vscode.commands.registerCommand('workbench.action.debug.start', () => {
      if (panel && animations && !deathLocked) {
        setAnimation('Run');
        if (successRunTimeout) {
          clearTimeout(successRunTimeout);
          successRunTimeout = null;
        }
      }
    })
  );

  // Wire events with enhanced behaviors and fixed idle detection
  function wireEvents() {
    // Typing → Walk with ultra-responsive idle detection
    vscode.workspace.onDidChangeTextDocument((e) => {
      lastTypeTime = Date.now();
      typingActive = true;
      idleBlinkCount = 0;

      if (deathLocked) return;
      if (successRunTimeout) return;

      if (!isTempActive()) setAnimation('Walk');
      
      // Clear any existing quick idle timeout
      if (quickIdleTimeout) {
        clearTimeout(quickIdleTimeout);
      }
      
      // Set a quick timeout to switch to idle - ultra responsive!
      quickIdleTimeout = setTimeout(() => {
        if (Date.now() - lastTypeTime >= 200 && !isTempActive() && !deathLocked && !successRunTimeout) {
          setAnimation('IdleBlink');
          typingActive = false;
        }
      }, 200); // Stop walking after just 200ms of no typing

      // Enhanced delete detection for Bite animation
      for (const change of e.contentChanges) {
        if (change.text === '' && change.rangeLength > 50) {
          // Large deletion - trigger bite
          playTemp('Bite', 600);
          break;
        }
      }
    }, null, context.subscriptions);

    // Enhanced idle behavior with occasional blinks - now more responsive
    const idleTicker = setInterval(() => {
      const now = Date.now();
      const timeSinceType = now - lastTypeTime;
      
      if (timeSinceType >= config.idleTimeout && !isTempActive() && !deathLocked && !successRunTimeout) {
        // Occasionally blink while idle for a long time
        if (idleBlinkCount < MAX_IDLE_BLINKS && Math.random() < 0.3) {
          idleBlinkCount++;
          playTemp('Blink', 400, () => {
            if (!deathLocked && !successRunTimeout) setAnimation('IdleBlink');
          });
        } else if (currentAnim !== 'IdleBlink') {
          setAnimation('IdleBlink');
        }
      }
    }, 500); // More frequent checks
    context.subscriptions.push({ dispose: () => clearInterval(idleTicker) });

    // Save → Sniff
    vscode.workspace.onDidSaveTextDocument(() => {
      if (!deathLocked && !successRunTimeout) playTemp('Sniff', 900);
    }, null, context.subscriptions);

    // Close doc → Tracking
    vscode.workspace.onDidCloseTextDocument(() => {
      if (!deathLocked && !successRunTimeout) playTemp('Tracking', 900);
    }, null, context.subscriptions);

    // Switch editor → Tracking
    vscode.window.onDidChangeActiveTextEditor(() => {
      if (!deathLocked && !successRunTimeout) playTemp('Tracking', 700);
      checkDiagnostics();
    }, null, context.subscriptions);

    // Diagnostics
    vscode.languages.onDidChangeDiagnostics(() => {
      if (config.enableBark) checkDiagnostics();
    }, null, context.subscriptions);

    // Task events
    vscode.tasks.onDidStartTaskProcess(() => {
      if (!deathLocked) {
        setAnimation('Run');
        if (successRunTimeout) {
          clearTimeout(successRunTimeout);
          successRunTimeout = null;
        }
      }
    }, null, context.subscriptions);

    vscode.tasks.onDidEndTaskProcess(e => {
      if (e.exitCode !== 0) {
        setAnimation('Death');
        deathLocked = true;
        if (successRunTimeout) {
          clearTimeout(successRunTimeout);
          successRunTimeout = null;
        }
        setTimeout(() => {
          deathLocked = false;
          if (!isTempActive()) applyBaseline();
        }, config.deathCooldown);
        if (diagBarkTimeout) {
          clearTimeout(diagBarkTimeout);
          diagBarkTimeout = null;
        }
      } else {
        successRunTimeout = setTimeout(() => {
          successRunTimeout = null;
          if (!isTempActive() && !deathLocked) applyBaseline();
        }, SUCCESS_RUN_DURATION_MS);
        setAnimation('Run');
      }
    }, null, context.subscriptions);

    // Debug events
    vscode.debug.onDidStartDebugSession(() => {
      if (!deathLocked) {
        setAnimation('Run');
        if (successRunTimeout) {
          clearTimeout(successRunTimeout);
          successRunTimeout = null;
        }
      }
    }, null, context.subscriptions);

    vscode.debug.onDidTerminateDebugSession(() => {
      if (!deathLocked && !successRunTimeout) {
        applyBaseline();
      }
    }, null, context.subscriptions);
  }

  function checkDiagnostics() {
    if (!panel || !animations || deathLocked || successRunTimeout || !config.enableBark) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;

    const diags = vscode.languages.getDiagnostics(ed.document.uri);
    const hasErr = diags.some(d => d.severity === vscode.DiagnosticSeverity.Error);
    const hasWarn = diags.some(d => d.severity === vscode.DiagnosticSeverity.Warning);
    const hasAny = hasErr || hasWarn;

    if (!hasAny) {
      if (diagBarkTimeout) {
        clearTimeout(diagBarkTimeout);
        diagBarkTimeout = null;
      }
      nextBarkAllowedAt = 0;
      if (!isTempActive() && !deathLocked) applyBaseline();
      return;
    }

    const now = Date.now();
    if (!diagBarkTimeout && now >= nextBarkAllowedAt) {
      diagBarkTimeout = setTimeout(() => {
        diagBarkTimeout = null;
        if (!panel || !animations || deathLocked) return;
        const curEd = vscode.window.activeTextEditor;
        if (!curEd) return;
        const curDiags = vscode.languages.getDiagnostics(curEd.document.uri);
        const stillErr = curDiags.some(d => d.severity === vscode.DiagnosticSeverity.Error);
        const stillWarn = curDiags.some(d => d.severity === vscode.DiagnosticSeverity.Warning);
        if (stillErr || stillWarn) {
          playTemp('Bark', 1200);
          nextBarkAllowedAt = Date.now() + 30000; // 30s cooldown
        }
      }, config.barkDelay);
    }
  }

  function loadAllAnimations(ctx: vscode.ExtensionContext, p: vscode.WebviewPanel): AnimMap {
    const media = path.join(ctx.extensionPath, 'media');
    const folders: AnimName[] = ['Bark','Bite','Blink','Death','IdleBlink','Run','Sniff','Tracking','Walk'];
    const res: Partial<AnimMap> = {};

    for (const folder of folders) {
      const dir = path.join(media, folder);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir)
          .filter(f => f.toLowerCase().endsWith('.png'))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      } catch {
        files = [];
      }
      (res as any)[folder] = files.map(f =>
        p.webview.asWebviewUri(vscode.Uri.file(path.join(dir, f))).toString()
      );
    }
    return res as AnimMap;
  }

  function setAnimation(name: AnimName, force = false) {
    if (!panel || !animations) return;
    if (!force && currentAnim === name) return;
    const frames = animations[name];
    if (!frames || frames.length === 0) return;
    const cfg = animConfig[name];
    panel.webview.postMessage({ type: 'set', name, frames, interval: cfg.intervalMs, loop: cfg.loop });
    currentAnim = name;
  }

  function playTemp(name: AnimName, ms: number, onDone?: () => void) {
    tempHoldUntil = Date.now() + ms;
    setAnimation(name, true);
    setTimeout(() => {
      if (Date.now() >= tempHoldUntil) {
        tempHoldUntil = 0;
        if (onDone) onDone(); else applyBaseline();
      }
    }, ms);
  }

  function isTempActive() {
    return Date.now() < tempHoldUntil;
  }

  function applyBaseline() {
    if (successRunTimeout) return;
    const idle = Date.now() - lastTypeTime > IDLE_THRESHOLD_MS;
    if (idle) setAnimation('IdleBlink');
    else setAnimation('Walk');
  }

  // Enhanced HTML with dragging and configuration support
  function initialHtml(): string {
    return /* html */ `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { 
      background: transparent; 
      margin: 0; 
      padding: 0; 
      width: 100%; 
      height: 100%; 
      overflow: hidden; 
      user-select: none;
    }
    #wrap { 
      position: fixed; 
      right: ${config.position.x}px; 
      bottom: ${config.position.y}px; 
      cursor: grab;
      transition: opacity 0.2s ease;
    }
    #wrap:active { cursor: grabbing; }
    #wrap:hover { opacity: 0.9; }
    #wrap canvas { display: block; }
  </style>
</head>
<body>
  <div id="wrap"><canvas id="dogc"></canvas></div>
  <script>
    const canvas = document.getElementById('dogc');
    const ctx = canvas.getContext('2d');
    const wrap = document.getElementById('wrap');
    ctx.imageSmoothingEnabled = false;

    let currentName = '';
    let frameUrls = [];
    let frameImages = [];
    let idx = 0;
    let rafId = null;
    let loop = true;
    let interval = 100;
    let last = 0;
    let acc = 0;
    let dogSize = ${config.size};

    const cache = new Map();

    // Dragging functionality
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    wrap.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = wrap.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const x = Math.max(0, Math.min(window.innerWidth - wrap.offsetWidth, 
        e.clientX - dragOffset.x));
      const y = Math.max(0, Math.min(window.innerHeight - wrap.offsetHeight, 
        e.clientY - dragOffset.y));
      
      wrap.style.left = x + 'px';
      wrap.style.top = y + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', (e) => {
      if (!isDragging) return;
      isDragging = false;
      
      const rect = wrap.getBoundingClientRect();
      const rightPos = window.innerWidth - rect.right;
      const bottomPos = window.innerHeight - rect.bottom;
      
      wrap.style.right = rightPos + 'px';
      wrap.style.bottom = bottomPos + 'px';
      wrap.style.left = 'auto';
      wrap.style.top = 'auto';
      
      window.postMessage({ 
        type: 'positionUpdate', 
        x: rightPos, 
        y: bottomPos 
      }, '*');
    });

    function setCanvasSizeFrom(img) {
      if (!img) return;
      const cssH = dogSize;
      const ratio = img.naturalWidth / img.naturalHeight;
      const cssW = Math.round(cssH * ratio);
      const dpr = window.devicePixelRatio || 1;
      
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
    }

    function draw(img) {
      if (!img) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }

    function tick(t) {
      rafId = requestAnimationFrame(tick);
      if (!last) { last = t; draw(frameImages[idx]); return; }
      const dt = t - last;
      last = t;
      acc += dt;
      if (acc >= interval) {
        acc -= interval;
        if (!loop && idx >= frameImages.length - 1) {
          cancelAnimationFrame(rafId);
          rafId = null;
          draw(frameImages[idx]);
          return;
        }
        idx = (idx + 1) % frameImages.length;
      }
      draw(frameImages[idx]);
    }

    function start() {
      if (!frameImages.length) return;
      if (rafId) cancelAnimationFrame(rafId);
      idx = 0;
      last = 0;
      acc = 0;
      setCanvasSizeFrom(frameImages[0]);
      rafId = requestAnimationFrame(tick);
    }

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
    }

    async function preload(name, urls) {
      if (cache.has(name)) return cache.get(name);
      const imgs = await Promise.all(urls.map(loadImage));
      cache.set(name, imgs);
      return imgs;
    }

    window.addEventListener('message', async ev => {
      const msg = ev.data;
      if (msg && msg.type === 'set') {
        currentName = msg.name || '';
        frameUrls = msg.frames || [];
        interval = typeof msg.interval === 'number' ? msg.interval : 100;
        loop = typeof msg.loop === 'boolean' ? msg.loop : true;
        try {
          frameImages = await preload(currentName, frameUrls);
          start();
        } catch (e) {
          // ignore load errors
        }
      } else if (msg && msg.type === 'updateConfig') {
        dogSize = msg.size || dogSize;
        if (msg.position) {
          wrap.style.right = msg.position.x + 'px';
          wrap.style.bottom = msg.position.y + 'px';
        }
        if (frameImages.length > 0) {
          setCanvasSizeFrom(frameImages[0]);
        }
      } else if (msg && msg.type === 'updatePosition') {
        wrap.style.right = msg.x + 'px';
        wrap.style.bottom = msg.y + 'px';
      }
    });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {
  // No global state to dispose beyond timers; panel dispose clears all timers
}