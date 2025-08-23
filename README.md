# Code Dog 🐶

A VS Code extension that adds an animated dog companion to your workspace. The dog reacts to your coding activities with different animations.

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/MohinVinayak.code-dog)](https://marketplace.visualstudio.com/items?itemName=MohinVinayak.code-dog)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/MohinVinayak.code-dog)](https://marketplace.visualstudio.com/items?itemName=MohinVinayak.code-dog)

## Features

**Reactive Animations**
- **Walk** - plays while typing
- **Run** - shows during debugging/task execution  
- **Sniff** - triggers when saving files
- **Bark** - alerts for errors and warnings
- **Bite** - activates on large code deletions
- **Death** - displays when tasks fail, then recovers
- **Idle Blink** - gentle animation when not active

**Interactive**
- Drag and drop to reposition anywhere on screen
- Position automatically saved between sessions
- Responsive timing that adapts to your coding rhythm

## Installation

1. Install from VS Code Extensions or the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=MohinVinayak.code-dog)
2. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run `Code Dog: Start`

The dog will appear in the bottom-right corner. Click and drag to move it anywhere.

## Commands

- `Code Dog: Start` - Launch the dog companion
- `Code Dog: Reset Position` - Return to default corner position
- `Code Dog: Test Run` - Preview the run animation
- `Code Dog: Test Bite` - Preview the bite animation

## Configuration

Access settings via File → Preferences → Settings, search for "codedog":

| Setting | Default | Description |
|---------|---------|-------------|
| `codedog.size` | 120 | Dog size in pixels |
| `codedog.enableBark` | true | Enable barking at code issues |
| `codedog.barkDelay` | 5000 | Delay before barking (ms) |
| `codedog.idleTimeout` | 10000 | Time before extended idle behavior (ms) |
| `codedog.deathCooldown` | 5000 | Recovery time after task failure (ms) |

## Performance

Lightweight design with minimal resource usage. Uses efficient animation caching and smart event handling to avoid impacting VS Code performance.

## Troubleshooting

**Dog not showing?** Try running `Code Dog: Start` again or restart VS Code.

**Need to reset position?** Use the `Code Dog: Reset Position` command.
