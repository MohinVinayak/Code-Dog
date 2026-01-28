import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/* ===================== Types ===================== */

type AnimName =
  | 'Bark' | 'Bite' | 'Blink' | 'Death' | 'IdleBlink'
  | 'Run' | 'Sniff' | 'Tracking' | 'Walk';

type AnimMap = Record<AnimName, string[]>;

type AnimConfig = {
  intervalMs: number;
  loop: boolean;
};

interface DogConfig {
  size: number;
  idleTimeout: number;
  enableBark: boolean;
  barkDelay: number;
  deathCooldown: number;
}

/* ===================== View Provider ===================== */

class CodeDogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codedog.view';

  private view?: vscode.WebviewView;
  private messageHandler?: (message: any) => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
      ]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Listen for messages from webview and forward to registered handler
    webviewView.webview.onDidReceiveMessage(
      message => {
        if (this.messageHandler) {
          this.messageHandler(message);
        }
      }
    );
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return initialHtml();
  }

  postMessage(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  get webview() {
    return this.view?.webview;
  }

  // Public method to register message handler
  public onMessage(handler: (message: any) => void): void {
    this.messageHandler = handler;
  }
}

/* ===================== Extension ===================== */

export function activate(context: vscode.ExtensionContext) {
  console.log('Code Dog extension activating...');

  const provider = new CodeDogViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CodeDogViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  /* ---------- Config ---------- */

  let config: DogConfig = {
    size: 120,
    idleTimeout: 10000,
    enableBark: true,
    barkDelay: 5000,
    deathCooldown: 5000
  };

  function loadConfig() {
    const c = vscode.workspace.getConfiguration('codedog');
    config.size = c.get('size', 120);
    config.idleTimeout = c.get('idleTimeout', 10000);
    config.enableBark = c.get('enableBark', true);
    config.barkDelay = c.get('barkDelay', 5000);
    config.deathCooldown = c.get('deathCooldown', 5000);
  }

  loadConfig();

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codedog')) {
        loadConfig();
      }
    })
  );

  /* ---------- State ---------- */

  let animations: AnimMap | null = null;
  let currentAnim: AnimName | null = null;
  let lastTypeTime = Date.now();
  let tempHoldUntil = 0;
  let deathLocked = false;
  let successRunTimeout: NodeJS.Timeout | null = null;
  let diagBarkTimeout: NodeJS.Timeout | null = null;
  let nextBarkAllowedAt = 0;
  let lastClickTime = 0; // For click cooldown

  const IDLE_THRESHOLD_MS = 300;
  const SUCCESS_RUN_DURATION_MS = 10000;
  const CLICK_COOLDOWN_MS = 2000; // 2 second cooldown for clicks

  const animConfig: Record<AnimName, AnimConfig> = {
    Bark: { intervalMs: 100, loop: true },
    Bite: { intervalMs: 80, loop: false },
    Blink: { intervalMs: 110, loop: false },
    Death: { intervalMs: 160, loop: false },
    IdleBlink: { intervalMs: 130, loop: true },
    Run: { intervalMs: 90, loop: true },
    Sniff: { intervalMs: 100, loop: true },
    Tracking: { intervalMs: 100, loop: true },
    Walk: { intervalMs: 100, loop: true }
  };

  /* ---------- Helpers ---------- */

  function isTempActive() {
    return Date.now() < tempHoldUntil;
  }

  function setAnimation(name: AnimName, force = false) {
    if (!animations || !provider.webview) {
      return;
    }
    if (!force && currentAnim === name) {
      return;
    }

    const frames = animations[name];
    if (!frames || frames.length === 0) {
      console.warn(`No frames found for animation: ${name}`);
      return;
    }

    const cfg = animConfig[name];
    provider.postMessage({
      type: 'set',
      name,
      frames,
      interval: cfg.intervalMs,
      loop: cfg.loop
    });

    currentAnim = name;
  }

  function playTemp(name: AnimName, ms: number) {
    tempHoldUntil = Date.now() + ms;
    setAnimation(name, true);
    setTimeout(() => {
      if (!isTempActive()) {
        applyBaseline();
      }
    }, ms);
  }

  function applyBaseline() {
    if (deathLocked || successRunTimeout) {
      return;
    }
    const idle = Date.now() - lastTypeTime > IDLE_THRESHOLD_MS;
    setAnimation(idle ? 'IdleBlink' : 'Walk');
  }

  /* ---------- Load Animations AFTER Webview Exists ---------- */

  const viewReady = setInterval(() => {
    if (!provider.webview) {
      return;
    }

    clearInterval(viewReady);

    animations = loadAllAnimations(context, provider.webview);

    if (animations) {
      setAnimation('IdleBlink');
      wireEvents();
    } else {
      vscode.window.showErrorMessage('Code Dog: Failed to load animations');
    }
  }, 100);

  /* ---------- Events ---------- */

  function wireEvents() {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file') {
          lastTypeTime = Date.now();
          if (!isTempActive()) {
            setAnimation('Walk');
          }
        }
      })
    );

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme === 'file') {
          playTemp('Sniff', 900);
        }
      })
    );

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        playTemp('Tracking', 700);
        checkDiagnostics();
      })
    );

    context.subscriptions.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        if (config.enableBark) {
          checkDiagnostics();
        }
      })
    );

    context.subscriptions.push(
      vscode.tasks.onDidStartTaskProcess(() => {
        setAnimation('Run');
      })
    );

    context.subscriptions.push(
      vscode.tasks.onDidEndTaskProcess(e => {
        if (e.exitCode !== 0) {
          setAnimation('Death');
          deathLocked = true;
          setTimeout(() => {
            deathLocked = false;
            applyBaseline();
          }, config.deathCooldown);
        } else {
          if (successRunTimeout) {
            clearTimeout(successRunTimeout);
          }
          successRunTimeout = setTimeout(() => {
            successRunTimeout = null;
            applyBaseline();
          }, SUCCESS_RUN_DURATION_MS);
          setAnimation('Run');
        }
      })
    );

    // Handle click events from webview using the public method
    provider.onMessage(message => {
      if (message.type === 'dogClicked') {
        const now = Date.now();
        if (now - lastClickTime > CLICK_COOLDOWN_MS) {
          lastClickTime = now;
          playTemp('Bark', 1000);
        }
      }
    });

    // Git integration - react to repository changes
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (gitExtension) {
        const gitApi = gitExtension.exports.getAPI(1);
        
        // Watch all repositories
        gitApi.repositories.forEach((repo: any) => {
          // Watch for HEAD changes (commits, branch switches)
          context.subscriptions.push(
            repo.state.onDidChange(() => {
              const headCommit = repo.state.HEAD?.commit;
              const branchName = repo.state.HEAD?.name;
              
              // Store previous commit to detect changes
              if (!repo._previousCommit) {
                repo._previousCommit = headCommit;
                repo._previousBranch = branchName;
                return;
              }

              // Commit detected
              if (headCommit !== repo._previousCommit && headCommit) {
                console.log('Code Dog: Commit detected!');
                playTemp('Run', 2000); // Celebrate commit
                repo._previousCommit = headCommit;
              }

              // Branch switch detected
              if (branchName !== repo._previousBranch && branchName) {
                console.log('Code Dog: Branch switch detected!');
                playTemp('Tracking', 1500);
                repo._previousBranch = branchName;
              }
            })
          );
        });

        // Watch for new repositories being added
        gitApi.onDidOpenRepository((repo: any) => {
          console.log('Code Dog: New repository opened');
          playTemp('Sniff', 1000);
        });

        console.log('Code Dog: Git integration enabled');
      } else {
        console.log('Code Dog: Git extension not found, git integration disabled');
      }
    } catch (err) {
      console.error('Code Dog: Error setting up git integration:', err);
    }
  }

  function checkDiagnostics() {
    if (!animations || deathLocked || successRunTimeout) {
      return;
    }
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }

    const diags = vscode.languages.getDiagnostics(ed.document.uri);
    const hasIssue = diags.some(d =>
      d.severity === vscode.DiagnosticSeverity.Error ||
      d.severity === vscode.DiagnosticSeverity.Warning
    );

    if (!hasIssue) {
      if (diagBarkTimeout) {
        clearTimeout(diagBarkTimeout);
        diagBarkTimeout = null;
      }
      return;
    }

    const now = Date.now();
    if (!diagBarkTimeout && now >= nextBarkAllowedAt) {
      diagBarkTimeout = setTimeout(() => {
        playTemp('Bark', 1200);
        nextBarkAllowedAt = Date.now() + 30000;
        diagBarkTimeout = null;
      }, config.barkDelay);
    }
  }

  /* ---------- Commands ---------- */

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.start', () => {
      vscode.commands.executeCommand('codedog.view.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.testRun', () => {
      playTemp('Run', 3000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedog.testBite', () => {
      playTemp('Bite', 800);
    })
  );

  console.log('Code Dog extension activated');
}

/* ===================== Helpers ===================== */

function loadAllAnimations(
  ctx: vscode.ExtensionContext,
  webview: vscode.Webview
): AnimMap | null {
  const media = path.join(ctx.extensionPath, 'media');
  const names: AnimName[] = [
    'Bark', 'Bite', 'Blink', 'Death', 'IdleBlink',
    'Run', 'Sniff', 'Tracking', 'Walk'
  ];

  const map = {} as AnimMap;

  try {
    for (const name of names) {
      const dir = path.join(media, name);
      let files: string[] = [];
      
      try {
        if (fs.existsSync(dir)) {
          files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.png'))
            .sort((a, b) => {
              // Sort by numeric value in filename (e.g., dog_bark_1.png, dog_bark_2.png)
              const numA = parseInt(a.match(/\d+/)?.[0] || '0');
              const numB = parseInt(b.match(/\d+/)?.[0] || '0');
              return numA - numB;
            });
          
          if (files.length > 0) {
            console.log(`Loaded ${files.length} frames for ${name}`);
          } else {
            console.warn(`No PNG files found in ${dir}`);
          }
        } else {
          console.warn(`Animation directory not found: ${dir}`);
        }
      } catch (err) {
        console.error(`Error reading animation directory ${name}:`, err);
      }

      map[name] = files.map(f =>
        webview.asWebviewUri(
          vscode.Uri.file(path.join(dir, f))
        ).toString()
      );
    }

    return map;
  } catch (err) {
    console.error('Error loading animations:', err);
    return null;
  }
}

/* ===================== HTML ===================== */

function initialHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Code Dog</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    #wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      height: 100%;
    }
    canvas {
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }
  </style>
</head>
<body>
  <div id="wrap">
    <canvas id="dog"></canvas>
  </div>

  <script>
    (function() {
      const canvas = document.getElementById('dog');
      const ctx = canvas.getContext('2d');
      const vscode = acquireVsCodeApi();
      
      if (!ctx) {
        console.error('Failed to get canvas context');
        return;
      }
      
      ctx.imageSmoothingEnabled = false;

      let frames = [];
      let images = [];
      let idx = 0;
      let interval = 100;
      let loop = true;
      let last = 0;
      let acc = 0;
      let raf = null;

      // Add click handler for the dog
      canvas.addEventListener('click', () => {
        vscode.postMessage({ type: 'dogClicked' });
      });

      // Add cursor pointer on hover
      canvas.style.cursor = 'pointer';

      function resize(img) {
        if (!img || !img.naturalWidth || !img.naturalHeight) {
          return;
        }
        
        const h = 120;
        const w = h * (img.naturalWidth / img.naturalHeight);
        canvas.style.height = h + 'px';
        canvas.style.width = w + 'px';
        canvas.height = h * window.devicePixelRatio;
        canvas.width = w * window.devicePixelRatio;
      }

      function draw(img) {
        if (!img) {
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      function tick(t) {
        raf = requestAnimationFrame(tick);
        
        if (!last) {
          last = t;
        }
        
        acc += t - last;
        last = t;
        
        if (acc >= interval) {
          acc = 0;
          
          if (!loop && idx >= images.length - 1) {
            return;
          }
          
          idx = (idx + 1) % images.length;
        }
        
        if (images[idx]) {
          draw(images[idx]);
        }
      }

      async function load(urls) {
        const promises = urls.map(u => {
          return new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('Failed to load: ' + u));
            i.src = u;
          });
        });
        
        return Promise.all(promises);
      }

      window.addEventListener('message', async e => {
        const data = e.data;
        
        if (data.type !== 'set') {
          return;
        }
        
        try {
          frames = data.frames || [];
          interval = data.interval || 100;
          loop = data.loop !== false;
          
          if (frames.length === 0) {
            console.warn('No frames provided');
            return;
          }
          
          images = await load(frames);
          idx = 0;
          last = 0;
          acc = 0;
          
          if (images.length > 0) {
            resize(images[0]);
            
            if (raf) {
              cancelAnimationFrame(raf);
            }
            
            raf = requestAnimationFrame(tick);
          }
        } catch (err) {
          console.error('Error loading animation:', err);
        }
      });
    })();
  </script>
</body>
</html>`;
}

export function deactivate() {
  console.log('Code Dog extension deactivating...');
}
